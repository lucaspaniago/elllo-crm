/**
 * SILÊNCIO DE PROPAGANDA — o disparo automático de empresa a quem nunca
 * escrevemos não acorda a IA, não abre card e sai da fila.
 *
 * Fork elllo. A detecção é pura e mora em `lib/waha/disparo-automatico.ts`;
 * aqui mora a decisão com o banco e os efeitos.
 *
 * ─── Onde roda, e por que não corre com a IA ───────────────────────────────
 *
 * `lib/waha/ingest.ts` chama `silenciarDisparoAutomatico` DEPOIS de gravar a
 * mensagem e ANTES de `aplicarEfeitosPosEntrada` — que é quem emite
 * `ai_agent.dispatch_requested` (o único pedido de turno do agent-engine para
 * uma entrada nova). Silenciada, a ingestão simplesmente não chama os efeitos:
 * o evento nunca nasce, e não há turno para cancelar depois. A decisão é
 * síncrona, na mesma request do webhook.
 *
 * ─── Quando silencia (decisão do dono, 07/11/2026) ─────────────────────────
 *
 * Só quando as TRÊS coisas valem:
 *
 *   1. a mensagem é disparo automático (modelo, interativa, botões, lista);
 *   2. `organizations.settings.crm.silenciar_disparos_automaticos` não é o
 *      booleano `false` — o padrão é LIGADO;
 *   3. nunca houve mensagem de SAÍDA nossa para este contato, em conversa
 *      nenhuma. Se nós escrevemos primeiro, é um prospect respondendo por robô
 *      de atendimento — e ele continua sendo atendido como hoje.
 *
 * Contato marcado como pessoal também não é silenciado: os efeitos já são
 * pulados para ele, e etiquetá-lo de "propaganda" seria marcar gente.
 *
 * ─── O que acontece quando silencia ────────────────────────────────────────
 *
 *   - o contato ganha a etiqueta `propaganda` (a mesma função atômica da ação
 *     `add_tag`, `fn_contato_adicionar_etiquetas`) e o `contact.tag_added`;
 *   - a conversa é encerrada como o botão "Encerrar" faz (`fn_service_status`
 *     → `closed`; soltando antes o atendente, se houver, como na marcação de
 *     contato pessoal);
 *   - a demanda que a mensagem abriu no Radar é encerrada como `nao_procede`;
 *   - nenhum card novo nasce (o nascimento do lead está nos efeitos pulados);
 *     card ABERTO que o contato já tivesse vai para a etapa de perdido do funil
 *     por `encerraDemanda` (a regra do botão "perdido"), motivo `other`. Funil
 *     sem etapa de perdido recusa, e o card fica onde está, com log;
 *   - nenhum aviso a ninguém. Fica o log `waha.disparo_automatico: silenciado`.
 *
 * ─── Nada aqui derruba a ingestão ──────────────────────────────────────────
 *
 * A mensagem já está gravada. Leitura que falha antes da decisão = NÃO
 * silencia (o comportamento de hoje: a IA atende). Efeito que falha depois da
 * decisão vira log, e os outros seguem — a IA continua sem ser acordada,
 * porque a decisão já foi tomada.
 */
import { z } from "zod";

import { audit } from "@/lib/audit";
import { lerPessoalDoContato } from "@/lib/contacts/contato-pessoal";
import { encerraDemanda } from "@/lib/leads/encerramento";
import type { CanonicalLostReason } from "@/lib/schemas/leads";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";
import { decidirSilencio, type DisparoAutomatico } from "@/lib/waha/disparo-automatico";

type Admin = ReturnType<typeof createAdminClient>;

/** A etiqueta que o contato silenciado ganha. */
export const ETIQUETA_DE_PROPAGANDA = "propaganda";

/** O ator de todos os efeitos: o produto agiu sobre o que chegou pelo canal. */
const ATOR = { type: "webhook_source", id: "disparo-automatico" } as const;

const MOTIVO_DA_PERDA = "other" satisfies CanonicalLostReason;
const DESFECHO_DA_DEMANDA = "nao_procede" as const;
const RAZAO_NA_TIMELINE = "Disparo automático de empresa (propaganda) sem conversa anterior";

/**
 * `settings.crm.silenciar_disparos_automaticos` — ausente ou torto = LIGADO; só
 * o booleano `false` desliga. Lido aqui, e não no `crmSettingsSchema` do
 * upstream, para não tocar aquele arquivo: toda escrita de `settings.crm` faz
 * `{ ...crm, chave }`, então a chave do fork sobrevive às telas do upstream.
 */
const silencioSchema = z
  .object({ silenciar_disparos_automaticos: z.boolean().catch(true) })
  .catch({ silenciar_disparos_automaticos: true });

export function silencioDeDisparosLigado(settings: unknown): boolean {
  const crm =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).crm
      : undefined;
  return silencioSchema.parse(crm ?? {}).silenciar_disparos_automaticos;
}

export interface EntradaDoSilencio {
  organizationId: string;
  contactId: string;
  conversationId: string;
  messageId: string | null;
  disparo: DisparoAutomatico | null;
  requestId?: string;
}

/**
 * As leituras e escritas, separadas da regra para o teste trocar o banco.
 * Leituras lançam em falha; escritas também — quem chama decide a política.
 */
export interface PortaDoSilencio {
  settingsDaOrganizacao(org: string): Promise<unknown>;
  jaEscrevemosAoContato(org: string, contato: string): Promise<boolean>;
  contatoPessoal(org: string, contato: string): Promise<boolean>;
  etiquetarContato(org: string, contato: string, etiqueta: string): Promise<void>;
  encerrarConversa(org: string, conversa: string): Promise<void>;
  encerrarNegociosAbertos(org: string, contato: string, conversa: string): Promise<void>;
}

/**
 * Decide e, se for o caso, silencia. Devolve `true` quando a mensagem foi
 * silenciada — e então quem chama NÃO roda os efeitos pós-entrada.
 */
export async function silenciarDisparoAutomatico(
  admin: Admin,
  entrada: EntradaDoSilencio,
  porta: PortaDoSilencio = portaDoSupabase(admin, entrada.requestId),
): Promise<boolean> {
  if (!entrada.disparo) return false;
  const base = {
    organization_id: entrada.organizationId,
    conversation_id: entrada.conversationId,
    message_id: entrada.messageId,
    tipo: entrada.disparo.tipo,
  };

  let decisao: ReturnType<typeof decidirSilencio>;
  try {
    const ligado = silencioDeDisparosLigado(await porta.settingsDaOrganizacao(entrada.organizationId));
    const jaEscrevemos = ligado
      ? await porta.jaEscrevemosAoContato(entrada.organizationId, entrada.contactId)
      : false;
    const contatoPessoal =
      ligado && !jaEscrevemos ? await porta.contatoPessoal(entrada.organizationId, entrada.contactId) : false;
    decisao = decidirSilencio({ disparo: entrada.disparo, ligado, jaEscrevemos, contatoPessoal });
  } catch (err) {
    logger.warn("waha.disparo_automatico: decisão indeterminada — segue como hoje", {
      ...base,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
    return false;
  }

  if (!decisao.silenciar) {
    logger.info("waha.disparo_automatico: não silenciado", { ...base, motivo: decisao.motivo });
    return false;
  }

  await efeito("etiqueta", base, () =>
    porta.etiquetarContato(entrada.organizationId, entrada.contactId, ETIQUETA_DE_PROPAGANDA),
  );
  await efeito("conversa", base, () => porta.encerrarConversa(entrada.organizationId, entrada.conversationId));
  await efeito("negocios", base, () =>
    porta.encerrarNegociosAbertos(entrada.organizationId, entrada.contactId, entrada.conversationId),
  );

  logger.info("waha.disparo_automatico: silenciado", { ...base, empresa: entrada.disparo.empresa });
  return true;
}

async function efeito(nome: string, base: Record<string, unknown>, fazer: () => Promise<void>): Promise<void> {
  try {
    await fazer();
  } catch (err) {
    logger.warn(`waha.disparo_automatico: efeito falhou (${nome}); os demais seguem`, {
      ...base,
      detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
    });
  }
}

// ─── A porta de verdade ─────────────────────────────────────────────────────

const ESTADOS_ENCERRADOS = new Set(["closed", "resolved", "archived"]);

export function portaDoSupabase(admin: Admin, requestId?: string): PortaDoSilencio {
  const pedido = requestId ?? null;
  return {
    async settingsDaOrganizacao(org) {
      const { data, error } = await admin.from("organizations").select("settings").eq("id", org).maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { settings?: unknown } | null)?.settings ?? null;
    },

    async jaEscrevemosAoContato(org, contato) {
      // Envio que FALHOU nunca saiu: o contato não recebeu nada nosso.
      const { data, error } = await admin
        .from("messages")
        .select("id")
        .eq("organization_id", org)
        .eq("contact_id", contato)
        .eq("direction", "outbound")
        .neq("status", "failed")
        .limit(1);
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    },

    async contatoPessoal(org, contato) {
      const { pessoal, erro } = await lerPessoalDoContato(admin, { organizationId: org, contactId: contato });
      if (erro) throw new Error(erro);
      return pessoal;
    },

    async etiquetarContato(org, contatoId, etiqueta) {
      const { data, error } = await admin.rpc("fn_contato_adicionar_etiquetas", {
        p_org: org,
        p_contato: contatoId,
        p_etiquetas: [etiqueta],
      });
      if (error) throw new Error(error.message);
      const retorno = (data ?? null) as { tags?: unknown; adicionadas?: unknown } | null;
      const adicionadas = Array.isArray(retorno?.adicionadas) ? retorno.adicionadas.map(String) : [];
      if (!adicionadas.length) return;
      const tags = Array.isArray(retorno?.tags) ? retorno.tags.map(String) : adicionadas;
      // O mesmo evento da ação `add_tag` e da edição do contatoId: a regra de
      // automação do cliente que olha a etiqueta enxerga esta também.
      await admin.rpc("emit_event", {
        p_event_type: "contact.tag_added",
        p_entity_kind: "contact",
        p_entity_id: contatoId,
        p_payload: { added_tags: adicionadas, tags, service_origin: null },
        p_metadata: { source: "disparo_automatico", request_id: pedido },
        p_organization_id: org,
      });
      await audit({
        action: "contact.tags_changed",
        organizationId: org,
        resourceType: "contact",
        resourceId: contatoId,
        requestId: pedido,
        metadata: { added: adicionadas, via: "disparo_automatico", actor_type: ATOR.type, actor_id: ATOR.id },
      });
    },

    async encerrarConversa(org, conversaId) {
      const { data, error } = await admin
        .from("conversations")
        .select("id, status, assigned_to_user_id, current_demanda_id")
        .eq("organization_id", org)
        .eq("id", conversaId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const conv = data as {
        status: string;
        assigned_to_user_id: string | null;
        current_demanda_id: string | null;
      } | null;
      if (!conv) return;

      if (!ESTADOS_ENCERRADOS.has(conv.status)) {
        // Soltar ANTES de fechar: o release de `fn_conversation_assign` grava
        // `open`, e gravar `open` numa conversaId já fechada é reabertura (a mesma
        // ordem de `app/api/v1/contacts/[id]/personal/route.ts`).
        if (conv.assigned_to_user_id) {
          const { error: soltaErro } = await admin.rpc("fn_conversation_assign", {
            p_organization_id: org,
            p_conversation_id: conversaId,
            p_to_user_id: null as unknown as string,
            p_reason: "release",
            p_enforce_expected: false,
          });
          if (soltaErro) throw new Error(soltaErro.message);
        }
        const { error: fechaErro } = await admin.rpc("fn_service_status", {
          p_org: org,
          p_conversation: conversaId,
          p_status: "closed",
        });
        if (fechaErro) throw new Error(fechaErro.message);
        await audit({
          action: "conversation.closed",
          organizationId: org,
          resourceType: "conversation",
          resourceId: conversaId,
          requestId: pedido,
          metadata: { via: "disparo_automatico", actor_type: ATOR.type, actor_id: ATOR.id },
        });
      }

      // A demanda do Radar que a mensagem abriu (o gatilho da `messages` abre
      // uma por episódio). Fechar a conversaId só lhe dá um próximo passo; sem
      // isto ela fica viva pedindo "registrar o desfecho" de uma propaganda.
      if (!conv.current_demanda_id) return;
      const { data: demanda, error: dErro } = await admin
        .from("demandas")
        .select("id, revision, fechada_em")
        .eq("organization_id", org)
        .eq("id", conv.current_demanda_id)
        .maybeSingle();
      if (dErro) throw new Error(dErro.message);
      const d = demanda as { id: string; revision: number; fechada_em: string | null } | null;
      if (!d || d.fechada_em) return;
      const { error: encerraErro } = await admin.rpc("fn_demanda_encerrar", {
        p_org: org,
        p_demanda: d.id,
        p_expected: d.revision,
        p_desfecho: DESFECHO_DA_DEMANDA,
        // `null` = não foi uma pessoa (`encerrada_por` referencia `auth.users`).
        p_actor: null as unknown as string,
      });
      if (encerraErro) throw new Error(encerraErro.message);
      await audit({
        action: "demanda.encerrada",
        organizationId: org,
        resourceType: "demanda",
        resourceId: d.id,
        requestId: pedido,
        metadata: { desfecho: DESFECHO_DA_DEMANDA, via: "disparo_automatico", actor_type: ATOR.type, actor_id: ATOR.id },
      });
    },

    async encerrarNegociosAbertos(org, contato, conversa) {
      const { data, error } = await admin
        .from("crm_leads")
        .select("id")
        .eq("organization_id", org)
        .eq("contact_id", contato)
        .eq("status", "open");
      if (error) throw new Error(error.message);
      for (const lead of (data ?? []) as Array<{ id: string }>) {
        try {
          await encerraDemanda(
            admin,
            { organization_id: org, actor: ATOR, requestId: pedido ?? `disparo-automatico:${conversa}` },
            {
              leadId: lead.id,
              desfecho: "lost",
              motivo: MOTIVO_DA_PERDA,
              razaoNaTimeline: RAZAO_NA_TIMELINE,
              payloadNaTimeline: { conversation_id: conversa },
            },
          );
        } catch (err) {
          // Funil sem etapa de perdido, campo obrigatório… o card fica onde está.
          logger.warn("waha.disparo_automatico: card aberto não foi encerrado", {
            organization_id: org,
            lead_id: lead.id,
            detail: err instanceof Error ? err.message.slice(0, 160) : "desconhecido",
          });
        }
      }
    },
  };
}
