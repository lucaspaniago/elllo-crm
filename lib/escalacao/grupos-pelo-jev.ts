/**
 * OS GRUPOS, GUARDADOS E AVALIADOS — NUNCA RESPONDIDOS (fork elllo, 16/11/2026).
 *
 * Pedido do dono: "nos grupos ela deve ir avaliando, não responder nada. E se
 * ela vir alguma coisa que eu deva responder, ela me mandar no dia seguinte,
 * num apanhado só."
 *
 * ## Três peças, todas atrás de `settings.crm.jev_do_fork.grupos`
 *
 *   1. **Ligar os grupos do número** (`ligarGruposSeNenhum`, pelo cron do
 *      apanhado, uma vez por hora): o número que NUNCA teve grupo nenhum na
 *      fila do CRM ganha todos os grupos que o WhatsApp devolver, pelo MESMO
 *      `alternarGrupo` da tela (que confirma o filtro do WhatsApp antes de
 *      gravar). Basta UMA linha na fila — ligada ou desligada pelo operador —
 *      para isto nunca mais mexer naquele número: a escolha da tela vence.
 *      ⚠️ Ligar o primeiro grupo troca o filtro do canal, e o provedor reinicia a
 *      sessão por alguns segundos (`definirRecebimentoDeGrupos`).
 *   2. **Grupo novo entra sozinho** (`ligarGrupoNovoNaEntrada`, chamado por
 *      `lib/grupos/ingest.ts`): com o filtro já aberto (há outro grupo LIGADO
 *      no mesmo número), a mensagem de um grupo que ainda não tem linha cria a
 *      linha ligada. Grupo com linha DESLIGADA continua descartado (o
 *      operador decidiu), e número sem grupo ligado segue como no autor.
 *   3. **O Jev lê cada mensagem recebida** (`./grupo-pelo-jev.handler.ts`) e,
 *      se ela vale a resposta do dono, a mensagem entra no apanhado.
 *
 * Em nenhuma das três a IA responde: a linha nasce com `ia_responde = false`
 * (o padrão da coluna), e só a tela muda isso.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Pergunta } from "@/lib/ai/decisao/cliente";
import { logger } from "@/lib/logger";

import { probabilidadeDoNoul, type ResultadoDoJevDoFork } from "./jev-do-fork";

/** A partir de quanto a mensagem de grupo vai para o apanhado. */
export const MINIMO_PARA_O_APANHADO = 0.7;
/** "Bom dia", figurinha e "kkk" não valem uma pergunta ao Jev. */
export const MINIMO_DE_CARACTERES_NO_GRUPO = 20;
const TETO_DO_TEXTO = 1_500;

export const PERGUNTAS_DO_GRUPO: Record<string, Pergunta> = {
  vale_responder: {
    tipo: "noul",
    instrucao:
      "Esta mensagem, num grupo de WhatsApp de que o dono da empresa participa, merece uma resposta dele? Sim quando alguém se dirige a ele ou à empresa, faz uma pergunta ou um pedido que ele pode atender, pede orçamento, indicação ou contato, ou traz uma oportunidade de negócio. Não para conversa geral do grupo, cumprimentos, correntes, notícias e propaganda.",
  },
};

export function textoDoGrupo(texto: string | null | undefined): string | null {
  const t = (texto ?? "").replace(/\s+/g, " ").trim();
  if ([...t].length < MINIMO_DE_CARACTERES_NO_GRUPO) return null;
  return [...t].slice(0, TETO_DO_TEXTO).join("");
}

export function estadoDoGrupo(e: {
  empresa: string | null;
  grupo: string | null;
  remetente: string | null;
  mensagem: string;
}): Record<string, unknown> {
  return {
    ...(e.empresa ? { empresa: e.empresa } : {}),
    ...(e.grupo ? { grupo: e.grupo } : {}),
    ...(e.remetente ? { quem_escreveu: e.remetente } : {}),
    mensagem: e.mensagem,
  };
}

/** A probabilidade de "vale responder", ou `null` quando o Jev não respondeu. */
export function valeResponder(r: ResultadoDoJevDoFork): number | null {
  if (!r.ok) return null;
  return probabilidadeDoNoul(r.respostas, "vale_responder");
}

// ---------------------------------------------------------------------------
// Ligar os grupos — produção.
// ---------------------------------------------------------------------------

/** O ator das linhas ligadas pelo fork: o admin mais antigo da organização. */
async function adminDaOrganizacao(admin: SupabaseClient, org: string): Promise<string | null> {
  const { data, error } = await admin
    .from("user_organizations")
    .select("user_id, created_at")
    .eq("organization_id", org)
    .eq("role", "admin")
    .not("accepted_at", "is", null)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ user_id: string }>)[0]?.user_id ?? null;
}

/**
 * Para cada número da organização que NUNCA teve linha na fila de grupos, liga
 * todos os grupos que o WhatsApp devolver. Devolve quantos ligou. Nunca lança.
 */
export async function ligarGruposSeNenhum(admin: SupabaseClient, org: string): Promise<number> {
  try {
    const { data: sessoes, error } = await admin
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", org)
      .is("archived_at", null);
    if (error) throw new Error(error.message);
    const ids = ((sessoes ?? []) as Array<{ id: string }>).map((s) => s.id);
    if (ids.length === 0) return 0;

    const { data: linhas, error: erroLinhas } = await admin
      .from("channel_session_groups")
      .select("channel_session_id")
      .eq("organization_id", org)
      .in("channel_session_id", ids);
    if (erroLinhas) throw new Error(erroLinhas.message);
    const comLinha = new Set(((linhas ?? []) as Array<{ channel_session_id: string }>).map((l) => l.channel_session_id));
    const semLinha = ids.filter((id) => !comLinha.has(id));
    if (semLinha.length === 0) return 0;

    const [{ alternarGrupo, criarDepsDeGrupos, listarGruposDoNumero }, { randomUUID }] = await Promise.all([
      import("@/lib/grupos/servico"),
      import("node:crypto"),
    ]);
    const ator = await adminDaOrganizacao(admin, org);
    if (!ator) return 0;
    const deps = criarDepsDeGrupos(admin);
    let ligados = 0;
    for (const channelSessionId of semLinha) {
      let grupos: Awaited<ReturnType<typeof listarGruposDoNumero>>;
      try {
        grupos = await listarGruposDoNumero(deps, { organizationId: org, channelSessionId });
      } catch {
        continue; // canal sem grupos, desconectado, provedor fora — tenta na próxima hora
      }
      for (const g of grupos.filter((x) => x.presente && !x.enabled)) {
        try {
          await alternarGrupo(deps, {
            organizationId: org,
            channelSessionId,
            groupChatId: g.chatId,
            subject: g.subject,
            ligar: true,
            actorUserId: ator,
            requestId: `elllo-grupos:${randomUUID()}`,
          });
          ligados += 1;
        } catch (err) {
          logger.warn("[grupos-pelo-jev] grupo não ligado", {
            organization_id: org,
            causa: err instanceof Error ? err.message.slice(0, 160) : String(err),
          });
          break; // filtro não confirmado: não insiste nos outros nesta hora
        }
      }
    }
    if (ligados > 0) logger.info("[grupos-pelo-jev] grupos ligados", { organization_id: org, ligados });
    return ligados;
  } catch (err) {
    logger.warn("[grupos-pelo-jev] ligar grupos falhou", {
      organization_id: org,
      causa: err instanceof Error ? err.message.slice(0, 160) : String(err),
    });
    return 0;
  }
}

export interface GrupoLigadoNaEntrada {
  id: string;
  subject: string | null;
  contactId: string | null;
  conversationId: string | null;
  iaResponde: boolean;
}

/**
 * A mensagem chegou de um grupo SEM linha na fila (o filtro já está aberto por
 * outro grupo): cria a linha ligada, com a IA calada. Linha existente (mesmo
 * desligada) = `null`, e a entrada descarta como sempre. Nunca lança.
 */
export async function ligarGrupoNovoNaEntrada(
  admin: SupabaseClient,
  org: string,
  session: string,
  chatId: string,
): Promise<GrupoLigadoNaEntrada | null> {
  try {
    const { settingsDaOrganizacao, lerJevDoFork } = await import("./jev-do-fork");
    if (!lerJevDoFork(await settingsDaOrganizacao(admin, org)).grupos) return null;
    // As linhas DESTE número: sem nenhuma ligada, o filtro do WhatsApp está
    // fechado e a mensagem nem deveria ter chegado (a primeira abertura é do
    // cron, `ligarGruposSeNenhum`); com linha para este grupo, o operador já
    // decidiu.
    const { data: linhas, error } = await admin
      .from("channel_session_groups")
      .select("group_chat_id, enabled")
      .eq("organization_id", org)
      .eq("channel_session_id", session)
      .limit(1_000);
    if (error) throw new Error(error.message);
    const doNumero = (Array.isArray(linhas) ? linhas : []) as Array<{ group_chat_id: string; enabled: boolean }>;
    if (!doNumero.some((l) => l.enabled)) return null;
    if (doNumero.some((l) => l.group_chat_id === chatId)) return null;
    const { data: criada, error: erroCriar } = await admin
      .from("channel_session_groups")
      .insert({
        organization_id: org,
        channel_session_id: session,
        group_chat_id: chatId,
        subject: null,
        enabled: true,
        enabled_at: new Date().toISOString(),
        enabled_by_user_id: null,
        ia_responde: false,
      })
      .select("id, subject, contact_id, conversation_id")
      .single();
    if (erroCriar) {
      if ((erroCriar as { code?: string }).code === "23505") return null; // o outro webhook criou
      throw new Error(erroCriar.message);
    }
    const c = criada as { id: string; subject: string | null; contact_id: string | null; conversation_id: string | null };
    logger.info("[grupos-pelo-jev] grupo novo ligado na entrada", { organization_id: org });
    return { id: c.id, subject: c.subject, contactId: c.contact_id, conversationId: c.conversation_id, iaResponde: false };
  } catch (err) {
    logger.warn("[grupos-pelo-jev] grupo novo não ligado; mensagem descartada", {
      organization_id: org,
      causa: err instanceof Error ? err.message.slice(0, 160) : String(err),
    });
    return null;
  }
}
