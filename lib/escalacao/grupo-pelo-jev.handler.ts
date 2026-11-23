/**
 * O Jev lê cada mensagem RECEBIDA num grupo e diz se ela vale a resposta do
 * dono (fork elllo, 16/11/2026). Vale = a mensagem entra em
 * `itens_do_apanhado` e aparece no apanhado da manhã seguinte. Ver
 * `./grupos-pelo-jev.ts`.
 *
 * Consome `message.group_received` (migration 0482), que nenhum consumidor de
 * `message.received` vê — a IA, o follow-up e as campanhas continuam cegos
 * para grupo. Este handler NUNCA responde nada: ele só lê e grava o item.
 *
 * Vai ao Jev só o texto da mensagem, o nome do grupo, o NOME de quem escreveu
 * (nunca o telefone) e o nome da empresa — o aceite de "cada mensagem,
 * sozinha".
 *
 * `naOrgParada: "pula"`: custa dinheiro e manda dado para fora.
 */
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { MENSAGEM_REDIGIDA } from "@/lib/lgpd/cascata";
import { createAdminClient } from "@/lib/supabase/admin";

export const GRUPO_PELO_JEV_HANDLER_KEY = "elllo-grupo-pelo-jev.v1";

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

export async function avaliarMensagemDeGrupo(row: EventRow): Promise<HandlerResult> {
  const ok = (status: HandlerResult["status"], detail: string): HandlerResult => ({
    consumer_key: GRUPO_PELO_JEV_HANDLER_KEY,
    status,
    detail,
  });
  const p = row.payload ?? {};
  if (p.direction !== "inbound") return ok("skipped", "grupo:nao_recebida");
  const messageId = texto(p.message_id);
  const conversationId = texto(p.conversation_id);
  if (!messageId || !conversationId) return ok("skipped", "grupo:sem_ponteiros");
  const org = row.organization_id;

  const admin = createAdminClient();
  const [jev, grupos] = await Promise.all([import("./jev-do-fork"), import("./grupos-pelo-jev")]);
  const settings = await jev.settingsDaOrganizacao(admin, org);
  const fork = jev.lerJevDoFork(settings);
  if (!fork.grupos) return ok("skipped", "grupo:desligado_no_fork");

  const [{ data: msg, error: erroMsg }, { data: conversa, error: erroConversa }, { data: orgRow }] = await Promise.all([
    admin
      .from("messages")
      .select("body, metadata, direction")
      .eq("organization_id", org)
      .eq("id", messageId)
      .maybeSingle(),
    admin
      .from("conversations")
      .select("is_group, contacts:contact_id(display_name, name)")
      .eq("organization_id", org)
      .eq("id", conversationId)
      .maybeSingle(),
    admin.from("organizations").select("display_name").eq("id", org).maybeSingle(),
  ]);
  if (erroMsg) throw new Error(erroMsg.message);
  if (erroConversa) throw new Error(erroConversa.message);
  const m = msg as { body: string | null; metadata: Record<string, unknown> | null; direction: string } | null;
  type Contato = { display_name: string | null; name: string | null };
  const lida = conversa as unknown as { is_group: boolean | null; contacts: Contato | Contato[] | null } | null;
  const c = lida
    ? { is_group: lida.is_group, contacts: Array.isArray(lida.contacts) ? (lida.contacts[0] ?? null) : lida.contacts }
    : null;
  if (!m || !c?.is_group || m.direction !== "inbound") return ok("skipped", "grupo:mensagem_ausente");
  if ((m.body ?? "").trim() === MENSAGEM_REDIGIDA) return ok("skipped", "grupo:redigida");
  const mensagem = grupos.textoDoGrupo(m.body);
  if (!mensagem) return ok("skipped", "grupo:texto_curto");

  const remetente = (m.metadata?.group_sender as { name?: unknown } | undefined)?.name;
  const r = await jev.perguntarAoJevDoFork(await jev.criarDepsDoJevDoFork(admin), {
    organizationId: org,
    contactId: null,
    proposito: jev.PROPOSITOS_DO_JEV_DO_FORK.grupo,
    estado: grupos.estadoDoGrupo({
      empresa: texto((orgRow as { display_name?: unknown } | null)?.display_name),
      grupo: nomeDoContato(c.contacts),
      remetente: texto(remetente),
      mensagem,
    }),
    perguntas: grupos.PERGUNTAS_DO_GRUPO,
    tetoDiarioUsd: fork.teto_diario_usd,
  });
  const p0 = grupos.valeResponder(r);
  if (p0 === null) return ok("skipped", `grupo:jev_${r.ok ? "ilegivel" : r.motivo}`);
  if (p0 < grupos.MINIMO_PARA_O_APANHADO) return ok("ok", "grupo:nao_vale");

  const { registrarItemDoApanhado } = await import("./itens-do-apanhado");
  await registrarItemDoApanhado(admin, {
    organizationId: org,
    tipo: "grupo",
    origem: "jev",
    messageId,
    conversationId,
    probabilidade: p0,
  });
  return ok("ok", "grupo:vale_responder");
}

export const grupoPeloJevHandler: EventHandler = {
  key: GRUPO_PELO_JEV_HANDLER_KEY,
  naOrgParada: "pula",
  events: ["message.group_received"],
  async handle(row): Promise<HandlerResult> {
    try {
      return await avaliarMensagemDeGrupo(row);
    } catch (err) {
      return {
        consumer_key: GRUPO_PELO_JEV_HANDLER_KEY,
        status: "error",
        detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
      };
    }
  },
};
