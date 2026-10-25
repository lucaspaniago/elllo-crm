/**
 * A SONDAGEM ANTES DA PASSAGEM POR SENTIMENTO (fork elllo).
 *
 * ## O que ela é
 *
 * Quando o clima da conversa cruza o limiar (`ai.sentiment_alert`), o caminho
 * de hoje passa a conversa para uma pessoa na hora (`triggerHandoff` com
 * `low_sentiment`). Muitas dessas passagens são brincadeira, ironia ou uma
 * frase mal lida — e cada uma vira um "já acionei o time" para o cliente e um
 * aviso para o dono. A sondagem põe UMA pergunta discreta entre o alerta e a
 * passagem:
 *
 *   1. silencia a IA até o prazo (padrão 10 min, `config_aviso_de_caso.
 *      sondagem_minutos`) e marca a conversa (`metadata.sondagem_de_passagem`);
 *   2. manda uma frase curta e neutra ("Oi! Acho que posso ter me perdido aqui.
 *      Posso te ajudar com algo?") — sem acusar, sem citar o que o cliente
 *      disse, sem prometer atendente;
 *   3. espera a resposta ou o prazo, e então passa — com o desfecho da sondagem
 *      no contexto da passagem e no aviso ao dono.
 *
 * Decisão do dono: a sondagem é SÓ para `low_sentiment`, e a passagem acontece
 * de qualquer jeito. O que ela muda é o que o dono sabe ao receber o aviso (a
 * resposta do cliente, a avaliação da IA) e se o cliente recebe o aviso de
 * passagem: quem não respondeu à pergunta não recebe um "já acionei o time".
 *
 * ## Quando NÃO há sondagem — e a passagem segue como hoje
 *
 * `aplicaSondagem` devolve `null` (o handler segue para o `triggerHandoff` de
 * sempre) quando: sem configuração ou `sondagem_minutos = 0`; sem contato;
 * contato pessoal, bloqueado ou anonimizado; grupo; a conversa não é elegível
 * para a IA (o mesmo gate do orquestrador); a IA nunca falou na conversa (a
 * guarda 1 de `avisarLeadDoCrm`); já houve sondagem nesta conversa em 24 h; e
 * QUALQUER erro. A sondagem é conforto; ela nunca pode custar a passagem.
 *
 * ## A chave na conversa, e por que é um CAS
 *
 * `metadata.sondagem_de_passagem = { evento_id, iniciada_em, prazo_em }`,
 * gravada com `bot_silenced_until = prazo_em` num UPDATE condicionado a a chave
 * NÃO existir. Dois alertas da mesma conversa no mesmo tick disputam a chave;
 * o perdedor devolve `skipped("sondagem_em_curso")` — o vencedor vai passar a
 * conversa. ⚠️ O merge do `metadata` é ler-e-gravar (o supabase-js não exprime
 * `metadata || …`): uma escrita concorrente em OUTRA chave do `metadata` da
 * mesma conversa, no mesmo milissegundo, pode se perder. O predicado do CAS é
 * só a ausência da chave de propósito — condicionar a `updated_at` faria
 * qualquer mensagem nova derrubar a sondagem.
 *
 * ## A espera: o handler NUNCA DORME
 *
 * Cada invocação olha o estado e volta com `retry` em `min(prazo, agora + 60 s)`.
 * Humano assumiu → limpa a chave e pula. Resposta do cliente depois da pergunta
 * → conclui com `respondeu = true`. Prazo vencido → conclui com `false`.
 *
 * ## Idempotência do envio
 *
 * Antes de mandar, procura a mensagem marcada com este `evento_id`. Sem ela e
 * com a chave gravada há menos de 2 min, outro processo pode estar enviando:
 * `retry`. Envio recusado → limpa a chave, devolve o silêncio e passa NA HORA.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { z } from "zod";

import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { idiomaVisivelPorCodigo } from "@/lib/i18n/registro";
import { logger } from "@/lib/logger";

import type { TriggerHandoffInput, TriggerHandoffResult } from "@/lib/ai/handoff/orchestrator";

import { montarTranscricao, type MensagemParaAvaliar } from "./avaliacao-da-passagem";
import { sanitizarTextoDoLead } from "./sanitizar-texto-do-lead";

/** A chave em `conversations.metadata`. */
export const CHAVE_DA_SONDAGEM = "sondagem_de_passagem";
/** O ator do envio — é o automático falando, não uma pessoa. */
export const ATOR_DA_SONDAGEM = "sondagem-de-passagem";
/** Uma sondagem por conversa dentro desta janela. */
export const JANELA_ENTRE_SONDAGENS_MS = 24 * 60 * 60 * 1000;
/** Chave sem mensagem há menos que isto: outro processo pode estar enviando. */
export const JANELA_DO_ENVIO_MS = 2 * 60 * 1000;
/** Cadência da espera. */
export const PASSO_DA_ESPERA_MS = 60 * 1000;
/** Chave vencida há mais que isto é abandonada (o processo que a dono morreu). */
export const FOLGA_DA_CHAVE_VENCIDA_MS = 30 * 60 * 1000;
/** Teto da frase. */
export const TETO_DA_PERGUNTA = 180;
/** Teto de espera do modelo — a frase de reserva é melhor que um handler parado. */
export const TIMEOUT_DA_PERGUNTA_MS = 6_000;

/**
 * As frases de RESERVA, escolhidas pelo hash do contato — a mesma pessoa vê
 * sempre a mesma, pessoas diferentes veem frases diferentes. Traduzidas pelo
 * dicionário (`lib/i18n/aviso-de-passagem.ts`). Objeto e não tupla: é a forma
 * que a cerca de chave de runtime (`i18n-espanhol-cobre-a-tela`) sabe resolver.
 */
export const PERGUNTAS_DE_RESERVA = {
  perdido: "Oi! Acho que posso ter me perdido aqui. Posso te ajudar com algo?",
  entendi: "Oi! Quero ter certeza de que entendi direito. Como posso te ajudar?",
  claro: "Desculpe se não fui claro. Me conta o que você precisa?",
} as const;
const ORDEM_DAS_RESERVAS = ["perdido", "entendi", "claro"] as const;

export interface ChaveDaSondagem {
  evento_id: string;
  iniciada_em: string;
  prazo_em: string;
}

export interface ConversaDaSondagem {
  metadata: Record<string, unknown> | null;
  bot_silenced_until: string | null;
  is_group: boolean;
  assignee_kind: string | null;
  contato: { is_personal: boolean; is_blocked: boolean; is_anonymized: boolean } | null;
}

export interface MensagemDaSondagem {
  id: string;
  created_at: string;
  status: string | null;
}

export interface SondagemDb {
  /** `null` = sem configuração de aviso nesta organização. */
  minutosDaSondagem(orgId: string): Promise<number | null>;
  carregaConversa(orgId: string, conversationId: string): Promise<ConversaDaSondagem | null>;
  /** A guarda 1 de `avisarLeadDoCrm`, sem contar o aviso nem a sondagem. */
  iaJaFalou(orgId: string, conversationId: string): Promise<boolean>;
  sondagemDesde(orgId: string, conversationId: string, desde: Date): Promise<boolean>;
  /** O CAS: grava chave + silêncio só se a chave não existe. `true` = ganhou. */
  marca(orgId: string, conversationId: string, chave: ChaveDaSondagem): Promise<boolean>;
  /**
   * Tira a chave (só se ainda é a deste evento). Com `devolverSilencio`, zera
   * `bot_silenced_until` se ele ainda é o que a sondagem gravou.
   */
  limpa(orgId: string, conversationId: string, chave: ChaveDaSondagem, devolverSilencio: boolean): Promise<void>;
  mensagemDaSondagem(orgId: string, conversationId: string, eventoId: string): Promise<MensagemDaSondagem | null>;
  /** A primeira fala do cliente depois de `desde`. */
  respostaDepois(orgId: string, conversationId: string, desde: string): Promise<{ id: string } | null>;
  /** Alguém da equipe escreveu depois de `desde`? */
  humanoFalouDepois(orgId: string, conversationId: string, desde: string): Promise<boolean>;
  /** O id da fala mais recente do cliente. */
  inboundMaisRecente(orgId: string, conversationId: string): Promise<string | null>;
  /** As últimas mensagens, para o modelo escrever a pergunta no contexto. */
  ultimasMensagens(orgId: string, conversationId: string, limite: number): Promise<MensagemParaAvaliar[]>;
  idioma(orgId: string): Promise<Idioma>;
}

export interface SondagemDeps {
  db: SondagemDb;
  clock: () => Date;
  /** O gate de elegibilidade da IA — o mesmo do orquestrador. */
  elegivel(orgId: string, conversationId: string, agora: Date): Promise<boolean>;
  /** A frase pelo modelo; `null` = use a reserva. */
  redigir(entrada: {
    organizationId: string;
    conversationId: string;
    idioma: Idioma;
    mensagens: readonly MensagemParaAvaliar[];
  }): Promise<string | null>;
  /** Manda pelo `sendMessageHandler`. `true` = saiu (`sent`/`delivered`/`read`). */
  enviar(entrada: {
    organizationId: string;
    conversationId: string;
    boundary: ServiceBoundary;
    body: string;
    eventoId: string;
  }): Promise<boolean>;
  /** A fronteira de serviço da mensagem, já conferida como atual; `null` = obsoleta. */
  fronteiraAtual(orgId: string, messageId: string): Promise<ServiceBoundary | null>;
  passar(input: TriggerHandoffInput): Promise<TriggerHandoffResult>;
}

export interface ContextoDaSondagem {
  row: EventRow;
  /** A fronteira já conferida pelo handler. */
  boundary: ServiceBoundary;
  conversationId: string;
  contactId: string | null;
  /** O `triggerHandoff` que o handler faria — a sondagem o completa. */
  passagem: TriggerHandoffInput;
}

export interface DesfechoDaSondagem {
  status: "ok" | "skipped" | "retry";
  detail: string;
  retry_at?: string;
}

function retry(quando: Date, detail: string): DesfechoDaSondagem {
  return { status: "retry", detail, retry_at: quando.toISOString() };
}

function lerChave(metadata: Record<string, unknown> | null): ChaveDaSondagem | null {
  const v = metadata?.[CHAVE_DA_SONDAGEM] as Partial<ChaveDaSondagem> | undefined;
  if (!v || typeof v !== "object") return null;
  if (typeof v.evento_id !== "string" || typeof v.prazo_em !== "string" || typeof v.iniciada_em !== "string") {
    return null;
  }
  return { evento_id: v.evento_id, iniciada_em: v.iniciada_em, prazo_em: v.prazo_em };
}

/** A frase de reserva desta pessoa, no idioma da organização. */
export function perguntaDeReserva(contactId: string | null, idioma: Idioma): string {
  const h = createHash("sha256").update(contactId ?? "").digest();
  const chave = ORDEM_DAS_RESERVAS[(h[0] ?? 0) % ORDEM_DAS_RESERVAS.length] ?? "perdido";
  return traduzir(PERGUNTAS_DE_RESERVA[chave], idioma);
}

/**
 * Aplica a sondagem a UMA linha de `ai.sentiment_alert`.
 *
 * `null` = sem sondagem: o handler segue com o `triggerHandoff` de sempre.
 * Qualquer exceção também vira `null` — exceto quando a chave DESTE evento já
 * está gravada, porque aí o silêncio dela barraria a passagem de sempre: a
 * recuperação limpa a chave e passa com o silêncio ignorado.
 */
export async function aplicaSondagem(
  deps: SondagemDeps,
  ctx: ContextoDaSondagem,
): Promise<DesfechoDaSondagem | null> {
  try {
    return await sondar(deps, ctx);
  } catch (err) {
    logger.warn("[sondagem] erro — a passagem segue sem sondagem", {
      conversation_id: ctx.conversationId,
      causa: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    try {
      const conversa = await deps.db.carregaConversa(ctx.row.organization_id, ctx.conversationId);
      const chave = lerChave(conversa?.metadata ?? null);
      if (!chave || chave.evento_id !== ctx.row.id) return null;
      await deps.db.limpa(ctx.row.organization_id, ctx.conversationId, chave, false);
      return paraDesfecho(
        await deps.passar({ ...ctx.passagem, sondagem: { silencioAte: chave.prazo_em, avisarLead: true } }),
      );
    } catch {
      return null;
    }
  }
}

function paraDesfecho(r: TriggerHandoffResult): DesfechoDaSondagem {
  return { status: r.triggered ? "ok" : "skipped", detail: r.reason };
}

async function sondar(deps: SondagemDeps, ctx: ContextoDaSondagem): Promise<DesfechoDaSondagem | null> {
  const agora = deps.clock();
  const orgId = ctx.row.organization_id;
  const conversa = await deps.db.carregaConversa(orgId, ctx.conversationId);
  if (!conversa) return null;

  let chave = lerChave(conversa.metadata);
  let acabouDeMarcar = false;

  // ── A chave é de OUTRO evento ────────────────────────────────────────────
  if (chave && chave.evento_id !== ctx.row.id) {
    const abandonada = agora.getTime() > Date.parse(chave.prazo_em) + FOLGA_DA_CHAVE_VENCIDA_MS;
    if (!abandonada) return { status: "skipped", detail: "sondagem_em_curso" };
    // Quem a gravou morreu sem concluir: sem limpar, a conversa nunca mais
    // teria sondagem (o CAS exige a chave ausente).
    await deps.db.limpa(orgId, ctx.conversationId, chave, true);
    chave = null;
  }

  // ── Início: as guardas, depois o CAS ─────────────────────────────────────
  if (!chave) {
    const minutos = await deps.db.minutosDaSondagem(orgId);
    if (minutos === null || minutos <= 0) return null;
    if (!ctx.contactId) return null;
    const c = conversa.contato;
    if (!c || c.is_personal || c.is_blocked || c.is_anonymized) return null;
    if (conversa.is_group) return null;
    if (!(await deps.elegivel(orgId, ctx.conversationId, agora))) return null;
    if (!(await deps.db.iaJaFalou(orgId, ctx.conversationId))) return null;
    if (
      await deps.db.sondagemDesde(
        orgId,
        ctx.conversationId,
        new Date(agora.getTime() - JANELA_ENTRE_SONDAGENS_MS),
      )
    ) {
      return null;
    }
    const nova: ChaveDaSondagem = {
      evento_id: ctx.row.id,
      iniciada_em: agora.toISOString(),
      prazo_em: new Date(agora.getTime() + minutos * 60_000).toISOString(),
    };
    if (!(await deps.db.marca(orgId, ctx.conversationId, nova))) {
      return { status: "skipped", detail: "sondagem_em_curso" };
    }
    chave = nova;
    acabouDeMarcar = true;
  }

  const prazo = new Date(chave.prazo_em);
  const proximaVolta = () =>
    new Date(Math.min(prazo.getTime(), agora.getTime() + PASSO_DA_ESPERA_MS));

  // ── O envio, idempotente ─────────────────────────────────────────────────
  const enviada = acabouDeMarcar
    ? null
    : await deps.db.mensagemDaSondagem(orgId, ctx.conversationId, chave.evento_id);
  if (!enviada) {
    if (!acabouDeMarcar && agora.getTime() - Date.parse(chave.iniciada_em) < JANELA_DO_ENVIO_MS) {
      return retry(
        new Date(Date.parse(chave.iniciada_em) + JANELA_DO_ENVIO_MS),
        "sondagem: outro processo pode estar enviando",
      );
    }
    const idioma = await deps.db.idioma(orgId);
    let body: string | null = null;
    try {
      body = await deps.redigir({
        organizationId: orgId,
        conversationId: ctx.conversationId,
        idioma,
        mensagens: await deps.db.ultimasMensagens(orgId, ctx.conversationId, 8),
      });
    } catch {
      body = null;
    }
    const pergunta = sanitizarTextoDoLead(body, TETO_DA_PERGUNTA) ?? perguntaDeReserva(ctx.contactId, idioma);
    let saiu = false;
    try {
      saiu = await deps.enviar({
        organizationId: orgId,
        conversationId: ctx.conversationId,
        boundary: ctx.boundary,
        body: pergunta,
        eventoId: chave.evento_id,
      });
    } catch (err) {
      logger.warn("[sondagem] envio recusado", {
        conversation_id: ctx.conversationId,
        causa: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
      saiu = false;
    }
    if (!saiu) return await passarSemSondagem(deps, ctx, chave);
    return retry(proximaVolta(), "sondagem enviada");
  }

  // A pergunta não chegou (o canal recusou depois): esperar não adianta.
  if (enviada.status === "failed") return await passarSemSondagem(deps, ctx, chave);

  // ── A espera ─────────────────────────────────────────────────────────────
  if (
    conversa.assignee_kind === "user" ||
    (await deps.db.humanoFalouDepois(orgId, ctx.conversationId, enviada.created_at))
  ) {
    await deps.db.limpa(orgId, ctx.conversationId, chave, false);
    return { status: "skipped", detail: "humano_assumiu" };
  }
  const resposta = await deps.db.respostaDepois(orgId, ctx.conversationId, enviada.created_at);
  if (resposta) return await concluir(deps, ctx, chave, enviada, true, agora);
  if (agora.getTime() >= prazo.getTime()) return await concluir(deps, ctx, chave, enviada, false, agora);
  return retry(proximaVolta(), "aguardando resposta da sondagem");
}

/** A pergunta não saiu: limpa a chave, devolve o silêncio e passa como hoje. */
async function passarSemSondagem(
  deps: SondagemDeps,
  ctx: ContextoDaSondagem,
  chave: ChaveDaSondagem,
): Promise<DesfechoDaSondagem> {
  await deps.db.limpa(ctx.row.organization_id, ctx.conversationId, chave, true);
  return paraDesfecho(
    await deps.passar({ ...ctx.passagem, sondagem: { silencioAte: chave.prazo_em, avisarLead: true } }),
  );
}

async function concluir(
  deps: SondagemDeps,
  ctx: ContextoDaSondagem,
  chave: ChaveDaSondagem,
  enviada: MensagemDaSondagem,
  respondeu: boolean,
  agora: Date,
): Promise<DesfechoDaSondagem> {
  const orgId = ctx.row.organization_id;
  // A fronteira de AGORA: o atendimento pode ter mudado durante a espera, e
  // passar com a fronteira do alerta seria agir sobre um episódio encerrado.
  const ultima = await deps.db.inboundMaisRecente(orgId, ctx.conversationId);
  const boundary = ultima ? await deps.fronteiraAtual(orgId, ultima) : null;
  if (!boundary || boundary.conversation_id !== ctx.conversationId) {
    await deps.db.limpa(orgId, ctx.conversationId, chave, true);
    return { status: "skipped", detail: "service_boundary_stale" };
  }
  const minutos = Math.max(0, Math.round((agora.getTime() - Date.parse(enviada.created_at)) / 60_000));
  const r = await deps.passar({
    ...ctx.passagem,
    serviceBoundary: boundary,
    metadata: { ...(ctx.passagem.metadata ?? {}), sondagem: { respondeu, minutos } },
    motivoTexto: respondeu
      ? "Sondagem: o cliente respondeu à pergunta da IA"
      : `Sondagem: sem resposta em ${minutos} min`,
    sondagem: { silencioAte: chave.prazo_em, avisarLead: respondeu },
  });
  await deps.db.limpa(orgId, ctx.conversationId, chave, false);
  return paraDesfecho(r);
}

// ---------------------------------------------------------------------------
// A frase pelo modelo — o ponto `sentiment_classify`, como a avaliação.
// ---------------------------------------------------------------------------

const perguntaSchema = z.object({
  mensagem: z.string().max(400).describe(`uma frase curta, até ${TETO_DA_PERGUNTA} caracteres`),
});

/** O prompt de sistema. Exportado para o teste prender o que ele proíbe. */
export function promptDaPergunta(idioma: Idioma): string {
  const lingua = idiomaVisivelPorCodigo(idioma).nomeNativo;
  return `Você escreve UMA mensagem curta de WhatsApp para um cliente, em nome do atendimento automático de uma empresa. A conversa ficou tensa ou confusa e você quer checar, com leveza, se entendeu o cliente.

Regras:
- uma frase curta e neutra, no máximo ${TETO_DA_PERGUNTA} caracteres, terminando em pergunta;
- não acuse o cliente, não cite nem repita o que ele disse, nem palavrões;
- não prometa atendente, pessoa, humano, retorno ou prazo;
- não use links, números, emojis em excesso nem formatação;
- escreva em ${lingua}.

Exemplo do tom: "Oi! Acho que posso ter me perdido aqui. Posso te ajudar com algo?"`;
}

/** O redator de produção. Imports TARDIOS, como `criarDepsDaAvaliacao`. */
export async function criarRedatorDaPergunta(): Promise<SondagemDeps["redigir"]> {
  const { criarDepsDaAvaliacao } = await import("./avaliacao-da-passagem");
  const ia = await criarDepsDaAvaliacao();
  const [{ generateObject }] = await Promise.all([import("ai")]);
  return async ({ organizationId, conversationId, idioma, mensagens }) => {
    const resolvido = await ia.resolverModelo(organizationId);
    if (!resolvido) return null;
    if (!(await ia.podeGastar(organizationId))) return null;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_DA_PERGUNTA_MS);
    const inicio = ia.agora();
    try {
      const gerado = await generateObject({
        model: resolvido.model as Parameters<typeof generateObject>[0]["model"],
        schema: perguntaSchema,
        system: promptDaPergunta(idioma),
        prompt: `Conversa até aqui:\n${montarTranscricao(mensagens) || "(sem mensagens)"}`,
        temperature: 0,
        maxOutputTokens: 200,
        abortSignal: abort.signal,
      });
      const usage = gerado.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      const promptTokens = usage?.inputTokens ?? 0;
      const completionTokens = usage?.outputTokens ?? 0;
      ia.registrar({
        organization_id: organizationId,
        conversation_id: conversationId,
        model: resolvido.modelId,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        latency_ms: ia.agora() - inicio,
        cost_cents: await ia.custo({ model: resolvido.modelId, promptTokens, completionTokens }),
        finish_reason: null,
      });
      return gerado.object.mensagem;
    } catch (err) {
      ia.registrar({
        organization_id: organizationId,
        conversation_id: conversationId,
        model: resolvido.modelId,
        prompt_tokens: 0,
        completion_tokens: 0,
        latency_ms: ia.agora() - inicio,
        cost_cents: 0,
        finish_reason: "error",
        error_payload: { message: err instanceof Error ? err.message.slice(0, 300) : String(err) },
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// Adapter de produção — `SondagemDb` e as dependências sobre o service role.
// ---------------------------------------------------------------------------

/** Quem escreve pela EQUIPE (a tela, o celular do dono). Automação e sistema não contam. */
const ORIGENS_HUMANAS = ["user", "crm", "external_device"];
/** Status de `messages` que significam "chegou ao cliente". */
const STATUS_ENTREGUE = new Set(["sent", "delivered", "read"]);

type Admin = SupabaseClient;

/**
 * ⚠️ TODA consulta filtra `organization_id` À MÃO: o client é o de service
 * role, que BYPASSA a RLS. A organização vem da linha do `event_log`.
 */
export function createSupabaseSondagemDb(admin: Admin): SondagemDb {
  async function metadataDe(orgId: string, conversationId: string) {
    const { data, error } = await admin
      .from("conversations")
      .select("metadata, bot_silenced_until")
      .eq("organization_id", orgId)
      .eq("id", conversationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const linha = data as { metadata: Record<string, unknown> | null; bot_silenced_until: string | null } | null;
    return { metadata: linha?.metadata ?? {}, silencio: linha?.bot_silenced_until ?? null };
  }

  return {
    async minutosDaSondagem(orgId) {
      const { data, error } = await admin
        .from("config_aviso_de_caso")
        .select("sondagem_minutos")
        .eq("organization_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const v = (data as { sondagem_minutos?: number | null } | null)?.sondagem_minutos;
      return typeof v === "number" ? v : null;
    },

    async carregaConversa(orgId, conversationId) {
      const { data, error } = await admin
        .from("conversations")
        .select(
          "metadata, bot_silenced_until, is_group, assignee_kind, contacts:contact_id(is_personal, is_blocked, is_anonymized)",
        )
        .eq("organization_id", orgId)
        .eq("id", conversationId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const c = data as unknown as {
        metadata: Record<string, unknown> | null;
        bot_silenced_until: string | null;
        is_group: boolean | null;
        assignee_kind: string | null;
        contacts: { is_personal: boolean | null; is_blocked: boolean | null; is_anonymized: boolean | null } | null;
      };
      return {
        metadata: c.metadata,
        bot_silenced_until: c.bot_silenced_until,
        is_group: Boolean(c.is_group),
        assignee_kind: c.assignee_kind,
        contato: c.contacts
          ? {
              is_personal: Boolean(c.contacts.is_personal),
              is_blocked: Boolean(c.contacts.is_blocked),
              is_anonymized: Boolean(c.contacts.is_anonymized),
            }
          : null,
      };
    },

    async iaJaFalou(orgId, conversationId) {
      const { data, error } = await admin
        .from("messages")
        .select("metadata")
        .eq("organization_id", orgId)
        .eq("conversation_id", conversationId)
        .eq("direction", "outbound")
        .eq("sent_via", "ai")
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw new Error(error.message);
      return ((data ?? []) as Array<{ metadata: Record<string, unknown> | null }>).some(
        (m) => m.metadata?.aviso_de_escalacao !== true && !m.metadata?.[CHAVE_DA_SONDAGEM],
      );
    },

    async sondagemDesde(orgId, conversationId, desde) {
      const { data, error } = await admin
        .from("messages")
        .select("id")
        .eq("organization_id", orgId)
        .eq("conversation_id", conversationId)
        .eq("direction", "outbound")
        .not(`metadata->${CHAVE_DA_SONDAGEM}`, "is", null)
        .gte("created_at", desde.toISOString())
        .limit(1);
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    },

    async marca(orgId, conversationId, chave) {
      const { metadata } = await metadataDe(orgId, conversationId);
      const { data, error } = await admin
        .from("conversations")
        .update({ metadata: { ...metadata, [CHAVE_DA_SONDAGEM]: chave }, bot_silenced_until: chave.prazo_em })
        .eq("organization_id", orgId)
        .eq("id", conversationId)
        .is(`metadata->${CHAVE_DA_SONDAGEM}`, null)
        .select("id");
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    },

    async limpa(orgId, conversationId, chave, devolverSilencio) {
      const { metadata, silencio } = await metadataDe(orgId, conversationId);
      if (lerChave(metadata)?.evento_id !== chave.evento_id) return;
      const { [CHAVE_DA_SONDAGEM]: _fora, ...resto } = metadata;
      const devolve =
        devolverSilencio && silencio !== null && Date.parse(silencio) === Date.parse(chave.prazo_em);
      const { error } = await admin
        .from("conversations")
        .update({ metadata: resto, ...(devolve ? { bot_silenced_until: null } : {}) })
        .eq("organization_id", orgId)
        .eq("id", conversationId)
        .eq(`metadata->${CHAVE_DA_SONDAGEM}->>evento_id`, chave.evento_id);
      if (error) throw new Error(error.message);
    },

    async mensagemDaSondagem(orgId, conversationId, eventoId) {
      const { data, error } = await admin
        .from("messages")
        .select("id, created_at, status")
        .eq("organization_id", orgId)
        .eq("conversation_id", conversationId)
        .eq("direction", "outbound")
        .eq(`metadata->${CHAVE_DA_SONDAGEM}->>evento_id`, eventoId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as MensagemDaSondagem | null) ?? null;
    },

    async respostaDepois(orgId, conversationId, desde) {
      const { data, error } = await admin
        .from("messages")
        .select("id")
        .eq("organization_id", orgId)
        .eq("conversation_id", conversationId)
        .eq("direction", "inbound")
        .gt("created_at", desde)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { id: string } | null) ?? null;
    },

    async humanoFalouDepois(orgId, conversationId, desde) {
      const { data, error } = await admin
        .from("messages")
        .select("id")
        .eq("organization_id", orgId)
        .eq("conversation_id", conversationId)
        .eq("direction", "outbound")
        .in("sent_via", ORIGENS_HUMANAS)
        .gt("created_at", desde)
        .limit(1);
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    },

    async inboundMaisRecente(orgId, conversationId) {
      const { data, error } = await admin
        .from("messages")
        .select("id")
        .eq("organization_id", orgId)
        .eq("conversation_id", conversationId)
        .eq("direction", "inbound")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { id: string } | null)?.id ?? null;
    },

    async ultimasMensagens(orgId, conversationId, limite) {
      const { data, error } = await admin
        .from("messages")
        .select("direction, sent_via, body, media_derived_text, metadata, created_at")
        .eq("organization_id", orgId)
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(limite);
      if (error) throw new Error(error.message);
      return (data ?? []) as MensagemParaAvaliar[];
    },

    async idioma(orgId) {
      const { normalizarIdioma } = await import("@/lib/i18n/idiomas");
      const { data } = await admin.from("organizations").select("locale").eq("id", orgId).maybeSingle();
      return normalizarIdioma((data as { locale?: string | null } | null)?.locale ?? null);
    },
  };
}

/**
 * A sondagem de produção, pronta para o handler: monta as dependências e
 * aplica. Qualquer falha AO MONTAR também vira `null` — a passagem de sempre.
 */
export async function aplicaSondagemDeProducao(
  admin: Admin,
  ctx: ContextoDaSondagem,
): Promise<DesfechoDaSondagem | null> {
  try {
    const [
      { sendMessageHandler },
      { decidirElegibilidadeDaConversaViaSupabase },
      { ttlDaAutorizacaoMs },
      { serviceFromMessage },
      { assertServiceBoundarySupabase },
      { triggerHandoff },
    ] = await Promise.all([
      import("@/app/api/v1/messages/_handler"),
      import("@/lib/ai/elegibilidade/consulta-supabase"),
      import("@/lib/ai/elegibilidade/gate"),
      import("@/lib/atendimento/origem-mensagem"),
      import("@/lib/atendimento/origem"),
      import("@/lib/ai/handoff/orchestrator"),
    ]);
    const deps: SondagemDeps = {
      db: createSupabaseSondagemDb(admin),
      clock: () => new Date(),
      async elegivel(orgId, conversationId, agora) {
        const d = await decidirElegibilidadeDaConversaViaSupabase(admin, {
          organizationId: orgId,
          conversationId,
          agora,
          ttlMs: ttlDaAutorizacaoMs(process.env),
        });
        return d !== null && d.permite;
      },
      redigir: await criarRedatorDaPergunta(),
      async enviar({ organizationId, conversationId, boundary, body, eventoId }) {
        const mensagem = await sendMessageHandler(
          admin,
          {
            organization_id: organizationId,
            serviceBoundary: boundary,
            actor: { type: "ai_agent", id: ATOR_DA_SONDAGEM, role: "manager" },
            requestId: `sondagem-${eventoId}`,
          },
          {
            conversation_id: conversationId,
            type: "text",
            body,
            // A linha se DECLARA, como o aviso de escalação: é texto de sistema,
            // e é por esta chave que a espera e a avaliação a reconhecem.
            metadata: { [CHAVE_DA_SONDAGEM]: { evento_id: eventoId } },
          },
        );
        return STATUS_ENTREGUE.has(mensagem.status ?? "");
      },
      async fronteiraAtual(orgId, messageId) {
        try {
          const b = await serviceFromMessage(admin, orgId, messageId);
          if (!b) return null;
          await assertServiceBoundarySupabase(admin, b);
          return b;
        } catch {
          return null;
        }
      },
      passar: (input) => triggerHandoff(input),
    };
    return await aplicaSondagem(deps, ctx);
  } catch (err) {
    logger.warn("[sondagem] dependências não montaram — a passagem segue sem sondagem", {
      conversation_id: ctx.conversationId,
      causa: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return null;
  }
}
