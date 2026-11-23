/**
 * O APANHADO DAS 7H AO DONO (fork elllo, 16/11/2026, migration 9004).
 *
 * Pedido do dono: "juntar todas as mensagens de propaganda no final do dia e me
 * passar no dia posterior, logo pela manhã, se teve alguma propaganda, alguma
 * mensagem em algum grupo que vale a pena eu responder… num apanhado só."
 *
 * ## O que sai
 *
 * UMA mensagem, separada do resumo da agenda, pelo MESMO número, conexão e
 * espaçamento da nota de tom áspero (a configuração do aviso de caso):
 *
 *     🗞️ Acme: apanhado de ontem (15/11)
 *
 *     Propagandas silenciadas: 2
 *     • Vymber Rádio Indoor: "RASGUE O BOLETO. NÃO O SEU LUCRO! Sua academia…"
 *     • Maria: "Promoção de uniformes para academias, 30% de desconto…"
 *
 *     Mensagens de grupo que valem resposta: 1
 *     • Academias MS, João: "Alguém indica um sistema de grade de aulas?"
 *       Abrir: https://crm.exemplo.com.br/app/inbox?id=<conversa>
 *
 * **Sem nada para contar, nada sai** (decisão do dono: "se teve alguma
 * propaganda…"). O texto é sempre limpo por `sanitizarTextoDoLead` (sem link,
 * sem telefone, sem CPF) e curto.
 *
 * ## Quando
 *
 * O cron (`app/api/v1/cron/apanhado-do-dono`) roda de 10 em 10 minutos e o
 * apanhado sai na primeira rodada entre 7h e 10h do fuso da organização — a
 * janela é a do resumo da agenda (`lib/agenda/aviso-de-agendamento.ts`): se o
 * número estiver parado às 7h, sai quando ele voltar, e depois das 10h já não
 * é apanhado da manhã.
 *
 * ## Uma vez só, sem tabela de envio
 *
 * Os itens de ANTES da meia-noite de hoje (até 3 dias para trás) que ainda
 * não foram são REIVINDICADOS com o dia de hoje num UPDATE condicional
 * (`incluido_em is null`) antes do envio; o envio que falha os devolve. Duas
 * rodadas ao mesmo tempo dividem os itens em vez de repetir.
 *
 * O núcleo é PURO (dependências injetadas); o adapter de produção mora no fim,
 * com imports TARDIOS.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { diaLocalISO, instanteDe, partesNoFuso } from "@/lib/agenda/fuso";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { MENSAGEM_REDIGIDA } from "@/lib/lgpd/cascata";
import { logger } from "@/lib/logger";

import { sanitizarTextoDoLead } from "./sanitizar-texto-do-lead";
import { linkDaConversa } from "./texto-do-aviso-de-passagem";
import type { TipoDoItem } from "./vocabulario-do-apanhado";

export const HORA_DO_APANHADO = 7;
export const ULTIMA_HORA_DO_APANHADO = 10;
/** Até quantos dias para trás um item esquecido ainda entra. */
export const DIAS_PARA_TRAS = 3;
/** Quantas linhas de cada tipo; o resto vira "e mais N". */
export const LINHAS_POR_TIPO = 10;
const TETO_DO_TRECHO = 90;
const TETO_DO_REMETENTE = 60;

/** Um item já lido, com o texto da mensagem (o banco só guarda o ponteiro). */
export interface ItemParaOApanhado {
  id: string;
  tipo: TipoDoItem;
  conversationId: string;
  criadoEm: string;
  /** O corpo da mensagem, ou a descrição da mídia. */
  texto: string | null;
  /** Empresa do disparo, nome do contato ou de quem escreveu no grupo. */
  remetente: string | null;
  /** O nome do grupo (só no tipo `grupo`). */
  grupo: string | null;
}

function aspas(texto: string | null): string | null {
  if (!texto || texto.trim() === MENSAGEM_REDIGIDA) return null;
  const limpo = sanitizarTextoDoLead(texto, TETO_DO_TRECHO);
  return limpo ? `"${limpo}"` : null;
}

function nome(texto: string | null): string | null {
  return texto ? sanitizarTextoDoLead(texto, TETO_DO_REMETENTE) : null;
}

function ddmm(diaIso: string): string {
  const [, mes, dia] = diaIso.split("-");
  return `${dia}/${mes}`;
}

/** A mensagem do apanhado, ou `null` quando não há nada para contar. Nunca lança. */
export function montarApanhado(e: {
  marca: string;
  /** O dia de ONTEM no fuso da organização (`YYYY-MM-DD`). */
  ontem: string;
  itens: readonly ItemParaOApanhado[];
  urlPublica: string;
}): string | null {
  const ordenados = [...e.itens].sort((a, b) => Date.parse(a.criadoEm) - Date.parse(b.criadoEm));
  const propagandas = ordenados.filter((i) => i.tipo === "propaganda");
  const grupos = ordenados.filter((i) => i.tipo === "grupo");
  if (propagandas.length === 0 && grupos.length === 0) return null;

  const blocos: string[] = [`🗞️ ${e.marca}: apanhado de ontem (${ddmm(e.ontem)})`];
  if (propagandas.length > 0) {
    const linhas = [`Propagandas silenciadas: ${propagandas.length}`];
    for (const p of propagandas.slice(0, LINHAS_POR_TIPO)) {
      const quem = nome(p.remetente) ?? "Remetente sem nome";
      const trecho = aspas(p.texto);
      linhas.push(`• ${quem}${trecho ? `: ${trecho}` : ""}`);
    }
    if (propagandas.length > LINHAS_POR_TIPO) linhas.push(`• e mais ${propagandas.length - LINHAS_POR_TIPO}`);
    blocos.push(linhas.join("\n"));
  }
  if (grupos.length > 0) {
    const linhas = [`Mensagens de grupo que valem resposta: ${grupos.length}`];
    for (const g of grupos.slice(0, LINHAS_POR_TIPO)) {
      const onde = [nome(g.grupo) ?? "Grupo", nome(g.remetente)].filter(Boolean).join(", ");
      const trecho = aspas(g.texto);
      linhas.push(`• ${onde}${trecho ? `: ${trecho}` : ""}`);
      linhas.push(`  Abrir: ${linkDaConversa(e.urlPublica, g.conversationId)}`);
    }
    if (grupos.length > LINHAS_POR_TIPO) linhas.push(`• e mais ${grupos.length - LINHAS_POR_TIPO}`);
    blocos.push(linhas.join("\n"));
  }
  return blocos.join("\n\n");
}

/** A janela do apanhado: entre 7h e 10h do fuso. */
export function dentroDaJanelaDoApanhado(agora: Date, fuso: string): boolean {
  const h = partesNoFuso(agora, fuso).hora;
  return h >= HORA_DO_APANHADO && h < ULTIMA_HORA_DO_APANHADO;
}

/** A meia-noite de hoje, o dia de hoje e o de ontem, no fuso. */
export function diasDoApanhado(agora: Date, fuso: string): { hoje: string; ontem: string; meiaNoite: Date } {
  const p = partesNoFuso(agora, fuso);
  const meiaNoite = instanteDe({ ano: p.ano, mes: p.mes, dia: p.dia, hora: 0, minuto: 0 }, fuso);
  return {
    hoje: diaLocalISO(agora, fuso),
    ontem: diaLocalISO(new Date(meiaNoite.getTime() - 12 * 60 * 60 * 1000), fuso),
    meiaNoite,
  };
}

// ---------------------------------------------------------------------------
// A orquestração, com as dependências injetadas.
// ---------------------------------------------------------------------------

export interface DestinoDoApanhado {
  channelSessionId: string;
  telefoneDestino: string;
}

export interface DepsDoApanhado {
  /** O número e a conexão da nota (config do aviso de caso), ou `null` = desligado. */
  destino(orgId: string): Promise<DestinoDoApanhado | null>;
  /** O interruptor do fork (`settings.crm.jev_do_fork.apanhado`). */
  ligado(orgId: string): Promise<boolean>;
  fuso(orgId: string): Promise<string>;
  marca(orgId: string): Promise<string>;
  /** Marca com `dia` os itens pendentes criados em [desde, ate) e devolve-os já lidos. */
  reivindicar(orgId: string, dia: string, desde: Date, ate: Date): Promise<ItemParaOApanhado[]>;
  /** Devolve os itens (o envio falhou). */
  soltar(orgId: string, ids: readonly string[]): Promise<void>;
  /** Envia o texto. `false` = não deu agora (canal, espaçamento): os itens voltam. */
  enviar(orgId: string, destino: DestinoDoApanhado, texto: string, agora: Date): Promise<{ enviado: boolean; motivo: string }>;
  urlPublica: string;
  clock(): Date;
}

export interface DesfechoDoApanhado {
  status: "ok" | "skipped";
  detail: string;
}

export async function aplicaApanhado(deps: DepsDoApanhado, orgId: string): Promise<DesfechoDoApanhado> {
  const agora = deps.clock();
  if (!(await deps.ligado(orgId))) return { status: "skipped", detail: "apanhado:desligado_no_fork" };
  const destino = await deps.destino(orgId);
  if (!destino) return { status: "skipped", detail: "apanhado:aviso_desligado" };
  const fuso = await deps.fuso(orgId);
  if (!dentroDaJanelaDoApanhado(agora, fuso)) return { status: "skipped", detail: "apanhado:fora_da_janela" };

  const { hoje, ontem, meiaNoite } = diasDoApanhado(agora, fuso);
  const desde = new Date(meiaNoite.getTime() - DIAS_PARA_TRAS * 24 * 60 * 60 * 1000);
  const itens = await deps.reivindicar(orgId, hoje, desde, meiaNoite);
  if (itens.length === 0) return { status: "skipped", detail: "apanhado:vazio" };

  const texto = montarApanhado({ marca: await deps.marca(orgId), ontem, itens, urlPublica: deps.urlPublica });
  if (!texto) {
    // Itens que não renderam linha (nada a contar): ficam marcados, não voltam.
    return { status: "skipped", detail: "apanhado:sem_texto" };
  }
  let r: { enviado: boolean; motivo: string };
  try {
    r = await deps.enviar(orgId, destino, texto, agora);
  } catch (err) {
    r = { enviado: false, motivo: err instanceof Error ? err.message.slice(0, 120) : "erro" };
  }
  if (!r.enviado) {
    await deps.soltar(
      orgId,
      itens.map((i) => i.id),
    );
    logger.warn("[apanhado] não saiu; os itens voltam para a próxima rodada", { organization_id: orgId, motivo: r.motivo });
    return { status: "skipped", detail: `apanhado:nao_saiu:${r.motivo}` };
  }
  logger.info("[apanhado] enviado", { organization_id: orgId, itens: itens.length });
  return { status: "ok", detail: `apanhado:enviado:${itens.length}` };
}

// ---------------------------------------------------------------------------
// Adapter de produção. ⚠️ Toda consulta filtra `organization_id` à mão: é o
// service role, que passa por cima da RLS.
// ---------------------------------------------------------------------------

type Admin = SupabaseClient;

export async function criarDepsDoApanhado(admin: Admin): Promise<DepsDoApanhado> {
  const [
    { createSupabaseAvisoDePassagemDb },
    { createSupabaseAvisoDb },
    { criarTransporteDoAviso },
    { criarPacingDoCanal },
    { enviarParte },
    { env },
    jev,
  ] = await Promise.all([
    import("./aviso-de-passagem-ao-suporte"),
    import("./aviso-ao-suporte"),
    import("./aviso-ao-suporte.handler"),
    import("@/lib/agent-engine/pacing/ledger-supabase"),
    import("./envio-em-partes"),
    import("@/lib/env"),
    import("./jev-do-fork"),
  ]);
  const { urlPublicaUsavel } = await import("./url-publica");
  const configs = createSupabaseAvisoDePassagemDb(admin);
  const canais = createSupabaseAvisoDb(admin);
  const transporte = await criarTransporteDoAviso(admin);
  const pacing = await criarPacingDoCanal(admin);

  return {
    urlPublica: env.NEXT_PUBLIC_APP_URL,
    clock: () => new Date(),
    async ligado(orgId) {
      return jev.lerJevDoFork(await jev.settingsDaOrganizacao(admin, orgId)).apanhado;
    },
    async destino(orgId) {
      const cfg = await configs.carregaConfig(orgId);
      if (!cfg || !cfg.ligado || !cfg.aviso_de_passagem_ligado || !cfg.channel_session_id) return null;
      return { channelSessionId: cfg.channel_session_id, telefoneDestino: cfg.telefone_destino };
    },
    async fuso(orgId) {
      const { data } = await admin.from("organizations").select("timezone").eq("id", orgId).maybeSingle();
      return (data as { timezone?: string | null } | null)?.timezone || "America/Sao_Paulo";
    },
    async marca(orgId) {
      return (await canais.marcaDaOrganizacao(orgId)).nome;
    },
    async reivindicar(orgId, dia, desde, ate) {
      const { data, error } = await admin
        .from("itens_do_apanhado")
        .update({ incluido_em: dia })
        .eq("organization_id", orgId)
        .is("incluido_em", null)
        .gte("created_at", desde.toISOString())
        .lt("created_at", ate.toISOString())
        .select("id, tipo, message_id, conversation_id, created_at");
      if (error) throw new Error(error.message);
      const linhas = (data ?? []) as Array<{
        id: string;
        tipo: TipoDoItem;
        message_id: string;
        conversation_id: string;
        created_at: string;
      }>;
      if (linhas.length === 0) return [];
      const { data: msgs, error: erroMsgs } = await admin
        .from("messages")
        .select("id, body, metadata, contacts:contact_id(display_name, name)")
        .eq("organization_id", orgId)
        .in(
          "id",
          linhas.map((l) => l.message_id),
        );
      if (erroMsgs) throw new Error(erroMsgs.message);
      // O embutido `contacts:contact_id(...)` chega como objeto (muitos-para-um),
      // mas o tipo inferido pelo supabase-js é lista: aceita os dois.
      type Contato = { display_name: string | null; name: string | null };
      const porId = new Map(
        ((msgs ?? []) as unknown as Array<{
          id: string;
          body: string | null;
          metadata: Record<string, unknown> | null;
          contacts: Contato | Contato[] | null;
        }>).map((m) => [m.id, { ...m, contacts: Array.isArray(m.contacts) ? (m.contacts[0] ?? null) : m.contacts }]),
      );
      return linhas.map((l) => {
        const m = porId.get(l.message_id);
        const md = m?.metadata ?? {};
        const empresa = (md.disparo_automatico as { empresa?: unknown } | undefined)?.empresa;
        const autor = (md.group_sender as { name?: unknown } | undefined)?.name;
        const contato = nomeDoContato(m?.contacts);
        // Só o texto que a pessoa escreveu. A descrição de foto fica de fora: o
        // apanhado não é leitor coberto por `haLeitorDaDescricao`, e a foto sem
        // legenda aparece só com o nome (o link leva à conversa).
        const corpo = (m?.body ?? "").trim() || null;
        return {
          id: l.id,
          tipo: l.tipo,
          conversationId: l.conversation_id,
          criadoEm: l.created_at,
          texto: corpo,
          remetente:
            l.tipo === "grupo"
              ? typeof autor === "string"
                ? autor
                : null
              : typeof empresa === "string"
                ? empresa
                : contato,
          grupo: l.tipo === "grupo" ? contato : null,
        };
      });
    },
    async soltar(orgId, ids) {
      if (ids.length === 0) return;
      const { error } = await admin
        .from("itens_do_apanhado")
        .update({ incluido_em: null })
        .eq("organization_id", orgId)
        .in("id", [...ids]);
      if (error) throw new Error(error.message);
    },
    async enviar(orgId, destino, texto, agora) {
      // A prontidão do canal, a mesma da nota de tom áspero.
      const canal = await canais.carregaCanal(orgId, destino.channelSessionId);
      if (!canal || canal.archived_at || canal.desativado || !canal.aceitaMensagemLivre) {
        return { enviado: false, motivo: "canal_indisponivel" };
      }
      if (canal.status !== "WORKING") return { enviado: false, motivo: "canal_desconectado" };
      if (!urlPublicaUsavel(env.NEXT_PUBLIC_APP_URL)) return { enviado: false, motivo: "sem_endereco_publico" };
      if (!(await transporte.configurado(orgId, canal))) return { enviado: false, motivo: "transporte_ausente" };
      const ritmo = await pacing.decide(orgId, destino.channelSessionId, agora);
      if (!ritmo.liberado) return { enviado: false, motivo: `pacing:${ritmo.motivo}` };
      if (await canais.destinoEhDaPropriaOrganizacao(orgId, destino.telefoneDestino)) {
        return { enviado: false, motivo: "destino_da_propria_organizacao" };
      }
      const to = await transporte.resolveDestino(orgId, canal, destino.telefoneDestino);
      if (!to) return { enviado: false, motivo: "destino_invalido" };
      await enviarParte({
        transporte,
        pacing,
        organizationId: orgId,
        canal,
        channelSessionId: destino.channelSessionId,
        to,
        partes: [texto],
        jaEnviadas: 0,
        agora,
      });
      try {
        await canais.registraJidDoAviso(orgId, to);
      } catch {
        // O JID do destino só evita que a resposta do dono vire conversa nova.
      }
      return { enviado: true, motivo: "ok" };
    },
  };
}

/** Itens com mais de 30 dias saem (o apanhado é da manhã seguinte). Nunca lança. */
export async function expurgarItensVelhos(admin: Admin, orgId: string, agora: Date = new Date()): Promise<void> {
  const limite = new Date(agora.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await admin
    .from("itens_do_apanhado")
    .delete()
    .eq("organization_id", orgId)
    .lt("created_at", limite);
  if (error) logger.warn("[apanhado] expurgo falhou", { organization_id: orgId, erro: error.message.slice(0, 160) });
}
