/**
 * A TOLERÂNCIA AO SENTIMENTO — a IA segue atendendo quando o tom fica áspero
 * (fork elllo).
 *
 * ## O que ela é
 *
 * No upstream, todo `ai.sentiment_alert` (o clima da conversa cruzou o limiar)
 * passa a conversa para uma pessoa NA HORA (`triggerHandoff` com
 * `low_sentiment`). Caso real que motivou esta regra: a irmã do dono escreveu
 * "Oi, idiota", de brincadeira; a conversa passou, o cliente recebeu "já acionei
 * o time" e o dono recebeu um aviso de passagem cuja própria avaliação dizia
 * "provável brincadeira (85%)". Decisão do dono (26/10/2026): a IA (a Helô, o
 * agente normal do CRM) continua conversando e resolve; passar para uma pessoa
 * só quando for preciso de verdade.
 *
 * A regra, a cada alerta, ANTES de qualquer passagem:
 *
 *   1. AVALIA a conversa (`./avaliacao-da-passagem.ts`, situação `tom_aspero`):
 *      hipótese — brincadeira, irritação real, engano, outro — e confiança.
 *   2. SEM irritação registrada na janela (`config_aviso_de_caso.
 *      sondagem_minutos`, reinterpretada pela migration 9003; padrão 30 min):
 *      REGISTRA a irritação na conversa e NÃO passa. O turno normal do agente,
 *      que roda por conta própria, responde ao cliente como sempre — esta regra
 *      NUNCA silencia a IA. Se a hipótese é brincadeira ou engano, o dono recebe
 *      UMA nota curta ("🔔 Acme: tom áspero, segui atendendo …") pelo mesmo
 *      número, conexão e espaçamento do aviso de caso.
 *   3. COM irritação na janela (a segunda): a avaliação agora vê a resposta da
 *      IA e a réplica do cliente. Passa — o `triggerHandoff` de sempre, motivo
 *      `low_sentiment` — SÓ se a hipótese é `irritacao_real` com confiança
 *      ≥ `CONFIANCA_PARA_PASSAR` (0,8). O aviso de passagem ao dono (gatilho da
 *      9002) sai sozinho, com o contexto inteiro. Senão não passa, renova a
 *      irritação e, se for brincadeira ou engano, manda a nota — no máximo uma
 *      nota por conversa por janela.
 *
 * Pedido explícito de atendente e opt-out NÃO passam por aqui: são outros
 * gatilhos, que não consomem `ai.sentiment_alert`.
 *
 * ## Quando é a passagem de sempre (`null`)
 *
 * `aplicaToleranciaAoSentimento` devolve `null` — o handler segue para o
 * `triggerHandoff` do upstream — quando: sem configuração de aviso, ou janela
 * 0; sem contato; contato pessoal, bloqueado ou anonimizado; grupo; humano já
 * assumiu (`assignee_kind = 'user'` ou `assigned_to_user_id`); a conversa não é
 * elegível para a IA (o MESMO gate do orquestrador — inclusive o silêncio de
 * uma passagem anterior). Em todos esses casos a IA não está atendendo, e
 * segurar a passagem deixaria o cliente sem ninguém; o caminho do upstream é o
 * que já sabe decidir (e o gate dele recusa o que precisa recusar).
 *
 * E QUALQUER erro ANTES de a irritação ficar registrada também vira `null`: na
 * dúvida, a irritação real nunca é engolida em silêncio. Depois do registro, a
 * nota é conforto — a falha dela é log, nunca passagem.
 *
 * **Avaliação indisponível** (orçamento, sem modelo, timeout): na PRIMEIRA
 * irritação só registra (sem nota); na SEGUNDA, passa — sem como confirmar que
 * é brincadeira, a segunda irritação na janela é tratada como o upstream a
 * trataria.
 *
 * ## A chave na conversa, e o CAS
 *
 * `conversations.metadata.tolerancia_de_sentimento` (`ChaveDaTolerancia`): o
 * instante da primeira e da última irritação, o evento da última, os eventos já
 * contados, a hipótese e a confiança da última avaliação, a reivindicação da
 * nota e a da passagem. Só hipótese e confiança — o texto do modelo nunca é
 * guardado. A janela conta a partir da ÚLTIMA irritação (`ultima_em`): uma
 * irritação mais velha que ela é como nenhuma.
 *
 * Toda escrita é um CAS sobre `versao` (o número sobe a cada escrita, e o UPDATE
 * só pega se a versão no banco é a que foi lida). Dois alertas da mesma conversa
 * no mesmo tick: o perdedor volta com `retry` em 5 s e, na volta, encontra a
 * irritação do vencedor. ⚠️ O merge do `metadata` é LER-E-GRAVAR (o supabase-js
 * não exprime `metadata || …`): uma escrita concorrente em OUTRA chave do
 * `metadata` da mesma conversa, entre a leitura e a gravação, pode se perder — e
 * uma escrita alheia que faça o mesmo pode apagar esta chave (o pior desfecho é
 * a próxima irritação contar como primeira: mais tolerância, nunca menos aviso).
 *
 * ## Idempotência — o dreno repete o mesmo evento
 *
 *   - evento já em `eventos` → a irritação NÃO conta de novo; só a nota
 *     pendente (se houver) é tentada, sem nova avaliação;
 *   - `nota_evento_id` é gravado (CAS) ANTES do envio: a repetição não manda a
 *     nota duas vezes. Envio que falha depois da reivindicação perde a nota (é
 *     conforto; fica no log);
 *   - `passagem_evento_id` é gravado (CAS) ANTES do `triggerHandoff`: a
 *     repetição de um evento que morreu no meio retoma a passagem (o orquestrador
 *     tem a própria deduplicação e o gate recusa a conversa que já passou).
 *     Depois da passagem a chave é APAGADA.
 *
 * O núcleo é PURO (dependências injetadas); o adapter de produção mora no fim,
 * com imports TARDIOS — o topo deste arquivo carrega sem ambiente.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { TriggerHandoffInput, TriggerHandoffResult } from "@/lib/ai/handoff/orchestrator";
import type { EventRow } from "@/lib/event-log/dispatcher";
import type { Idioma } from "@/lib/i18n/idiomas";
import { MENSAGEM_REDIGIDA } from "@/lib/lgpd/cascata";
import { logger } from "@/lib/logger";

import {
  MENSAGENS_DA_AVALIACAO,
  type MensagemParaAvaliar,
  type ResultadoDaAvaliacao,
  type SituacaoDaAvaliacao,
} from "./avaliacao-da-passagem";
import {
  ADIAMENTO_DO_DRENO_EM_REQUEST_MS,
  IDADE_MAXIMA_DO_EVENTO_MS,
  type AvisoDb,
  type PacingDoAviso,
  type TransporteDoAviso,
} from "./aviso-ao-suporte";
import type { ConfigDoAvisoDePassagem } from "./aviso-de-passagem-ao-suporte";
import { enviarParte } from "./envio-em-partes";
import type { MotivoDaPassagem } from "./passagem";
import { linkDaConversa, montarNotaDeTomAspero } from "./texto-do-aviso-de-passagem";
import { urlPublicaUsavel } from "./url-publica";
import { HIPOTESES_DA_PASSAGEM, type HipoteseDaPassagem } from "./vocabulario-do-aviso-de-passagem";

/** A chave em `conversations.metadata`. */
export const CHAVE_DA_TOLERANCIA = "tolerancia_de_sentimento";
/**
 * A confiança mínima da avaliação para a SEGUNDA irritação passar a conversa.
 * Decisão do dono: abaixo de 80% a dúvida fica com a IA, que segue atendendo.
 */
export const CONFIANCA_PARA_PASSAR = 0.8;
/** As hipóteses que rendem a nota curta ao dono. */
export const HIPOTESES_COM_NOTA: ReadonlySet<HipoteseDaPassagem> = new Set<HipoteseDaPassagem>([
  "brincadeira",
  "engano",
]);
/** O perdedor do CAS volta em 5 s e encontra a irritação do vencedor. */
export const ADIAMENTO_DA_DISPUTA_MS = 5_000;
/** Quantos eventos contados a chave lembra (a repetição é sempre recente). */
export const TETO_DE_EVENTOS_CONTADOS = 10;
/** O motivo da passagem que esta regra segura. */
const MOTIVO: MotivoDaPassagem = "low_sentiment";

export interface ChaveDaTolerancia {
  /** O token do CAS: sobe a cada escrita. */
  versao: number;
  /** A primeira irritação desta série. */
  primeira_em: string;
  /** A última irritação contada — a janela conta a partir dela. */
  ultima_em: string;
  /** O evento da última irritação contada. */
  evento_id: string;
  /** Os eventos já contados (os últimos `TETO_DE_EVENTOS_CONTADOS`). */
  eventos: string[];
  /** A hipótese da última avaliação; `null` = avaliação indisponível. */
  hipotese: HipoteseDaPassagem | null;
  confianca: number | null;
  /** O evento que reivindicou a última nota ao dono, e quando. */
  nota_evento_id: string | null;
  nota_em: string | null;
  /** O evento que reivindicou a passagem (antes do `triggerHandoff`). */
  passagem_evento_id: string | null;
}

export interface ConversaDaTolerancia {
  metadata: Record<string, unknown> | null;
  is_group: boolean;
  assignee_kind: string | null;
  assigned_to_user_id: string | null;
  contato: { is_personal: boolean; is_blocked: boolean; is_anonymized: boolean } | null;
}

/** Uma mensagem lida para a avaliação — com o id, para achar a do alerta. */
export interface MensagemDaTolerancia extends MensagemParaAvaliar {
  id: string;
}

export interface ToleranciaDb {
  /** A linha de `config_aviso_de_caso` (a janela, o destino, os botões). */
  carregaConfig(orgId: string): Promise<ConfigDoAvisoDePassagem | null>;
  carregaConversa(orgId: string, conversationId: string): Promise<ConversaDaTolerancia | null>;
  /**
   * O CAS: grava `nova` (ou APAGA a chave, com `null`) só se a versão no banco
   * ainda é `esperada` (`null` = chave ausente). `true` = gravou.
   */
  gravaChave(
    orgId: string,
    conversationId: string,
    esperada: number | null,
    nova: ChaveDaTolerancia | null,
  ): Promise<boolean>;
  /** As últimas mensagens da conversa, da mais nova para a mais antiga. */
  ultimasMensagens(
    orgId: string,
    conversationId: string,
    limite: number,
  ): Promise<MensagemDaTolerancia[]>;
}

/** O que só a NOTA precisa — montado só quando uma nota vai sair. */
export interface EnvioDaNota {
  canais: Pick<
    AvisoDb,
    "carregaCanal" | "destinoEhDaPropriaOrganizacao" | "registraJidDoAviso" | "nomeDoContato"
  >;
  transporte: TransporteDoAviso;
  pacing: PacingDoAviso;
  /** `env.NEXT_PUBLIC_APP_URL` já LIDO. */
  urlPublica: string;
}

export interface ToleranciaDeps {
  db: ToleranciaDb;
  /** O nome da marca (`marcaDaSaida`) e o idioma da organização — os dos avisos. */
  marca(orgId: string): Promise<{ nome: string; idioma: Idioma }>;
  /** O gate de elegibilidade da IA — o mesmo do orquestrador. */
  elegivel(orgId: string, conversationId: string, agora: Date): Promise<boolean>;
  avaliar(entrada: {
    organizationId: string;
    conversationId: string;
    idioma: Idioma;
    motivoCodigo: MotivoDaPassagem;
    mensagens: readonly MensagemParaAvaliar[];
    situacao: SituacaoDaAvaliacao;
  }): Promise<ResultadoDaAvaliacao>;
  /** O `triggerHandoff` do upstream. */
  passar(input: TriggerHandoffInput): Promise<TriggerHandoffResult>;
  envio(): Promise<EnvioDaNota>;
  clock: () => Date;
  origemDoDreno: () => "worker" | "request";
}

export interface ContextoDaTolerancia {
  row: EventRow;
  conversationId: string;
  contactId: string | null;
  /** A mensagem que o clima mediu — a do trecho na nota. */
  messageId: string | null;
  /** O `triggerHandoff` que o handler faria — idêntico ao do upstream. */
  passagem: TriggerHandoffInput;
}

export interface DesfechoDaTolerancia {
  status: "ok" | "skipped" | "retry";
  detail: string;
  retry_at?: string;
}

function retry(quando: Date, detail: string): DesfechoDaTolerancia {
  return { status: "retry", detail, retry_at: quando.toISOString() };
}

function seguiu(motivo: string): DesfechoDaTolerancia {
  return { status: "skipped", detail: `tolerancia:seguiu_atendendo:${motivo}` };
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * A chave lida do `metadata`. Sem `versao` numérica = ausente (o CAS de
 * "ausente" é `->>versao is null`, que também cobre lixo sem versão). Campo
 * estragado vira o neutro: `ultima_em` ilegível conta como janela vencida.
 */
export function lerChave(metadata: Record<string, unknown> | null): ChaveDaTolerancia | null {
  const v = metadata?.[CHAVE_DA_TOLERANCIA];
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  if (typeof c.versao !== "number" || !Number.isFinite(c.versao)) return null;
  const hipotese = (HIPOTESES_DA_PASSAGEM as readonly unknown[]).includes(c.hipotese)
    ? (c.hipotese as HipoteseDaPassagem)
    : null;
  return {
    versao: c.versao,
    primeira_em: texto(c.primeira_em) ?? "",
    ultima_em: texto(c.ultima_em) ?? "",
    evento_id: texto(c.evento_id) ?? "",
    eventos: Array.isArray(c.eventos)
      ? c.eventos.filter((e): e is string => typeof e === "string")
      : [],
    hipotese,
    confianca: typeof c.confianca === "number" ? c.confianca : null,
    nota_evento_id: texto(c.nota_evento_id),
    nota_em: texto(c.nota_em),
    passagem_evento_id: texto(c.passagem_evento_id),
  };
}

/** A irritação ainda vale? `false` também para instante ilegível. */
function dentroDaJanela(instante: string | null, agora: Date, janelaMs: number): boolean {
  if (!instante) return false;
  const t = Date.parse(instante);
  return Number.isFinite(t) && agora.getTime() - t < janelaMs;
}

/** A segunda irritação passa? Ver o cabeçalho (indisponível = passa). */
export function segundaIrritacaoPassa(avaliacao: ResultadoDaAvaliacao): boolean {
  if (!avaliacao.disponivel) return true;
  return avaliacao.hipotese === "irritacao_real" && avaliacao.confianca >= CONFIANCA_PARA_PASSAR;
}

function passouDoTeto(row: EventRow, agora: Date): boolean {
  if (!row.created_at) return false;
  const emitido = Date.parse(row.created_at);
  if (Number.isNaN(emitido)) return false;
  return agora.getTime() - emitido > IDADE_MAXIMA_DO_EVENTO_MS;
}

/** A fala do alerta; sem ela, a última fala do cliente com texto. */
function trechoDoAlerta(
  mensagens: readonly MensagemDaTolerancia[],
  messageId: string | null,
): string | null {
  const textoDe = (m: MensagemDaTolerancia): string | null => {
    const t = (m.body ?? "").trim() || (m.media_derived_text ?? "").trim();
    return t === "" || t === MENSAGEM_REDIGIDA ? null : t;
  };
  const doAlerta = messageId ? mensagens.find((m) => m.id === messageId) : undefined;
  if (doAlerta && textoDe(doAlerta)) return textoDe(doAlerta);
  const ultima = [...mensagens]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .find((m) => m.direction === "inbound" && textoDe(m) !== null);
  return ultima ? textoDe(ultima) : null;
}

/**
 * Aplica a tolerância a UMA linha de `ai.sentiment_alert`.
 *
 * `null` = a passagem de sempre: o handler segue com o `triggerHandoff` do
 * upstream. Qualquer exceção também vira `null` (ver o cabeçalho).
 */
export async function aplicaToleranciaAoSentimento(
  deps: ToleranciaDeps,
  ctx: ContextoDaTolerancia,
): Promise<DesfechoDaTolerancia | null> {
  try {
    return await tolerar(deps, ctx);
  } catch (err) {
    logger.warn("[tolerancia] erro — a passagem segue como no upstream", {
      conversation_id: ctx.conversationId,
      causa: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return null;
  }
}

async function tolerar(
  deps: ToleranciaDeps,
  ctx: ContextoDaTolerancia,
): Promise<DesfechoDaTolerancia | null> {
  const agora = deps.clock();
  const orgId = ctx.row.organization_id;
  const eventoId = ctx.row.id;

  // ── As guardas: fora delas, a passagem de sempre ─────────────────────────
  const cfg = await deps.db.carregaConfig(orgId);
  const minutos = cfg?.sondagem_minutos ?? 0;
  if (!cfg || !(minutos > 0)) return null;
  if (!ctx.contactId) return null;
  const conversa = await deps.db.carregaConversa(orgId, ctx.conversationId);
  if (!conversa) return null;
  const c = conversa.contato;
  if (!c || c.is_personal || c.is_blocked || c.is_anonymized) return null;
  if (conversa.is_group) return null;
  if (conversa.assignee_kind === "user" || conversa.assigned_to_user_id) return null;
  if (!(await deps.elegivel(orgId, ctx.conversationId, agora))) return null;

  // Dreno DENTRO da requisição: a avaliação (até 8 s de modelo) e a nota não
  // rodam dentro de um webhook — a mesma régua dos dois avisos.
  if (deps.origemDoDreno() === "request") {
    return retry(
      new Date(agora.getTime() + ADIAMENTO_DO_DRENO_EM_REQUEST_MS),
      "tolerancia: adiada (dreno dentro do webhook)",
    );
  }

  const janelaMs = minutos * 60_000;
  const chave = lerChave(conversa.metadata);

  // ── A repetição do MESMO evento: nada conta de novo ──────────────────────
  if (chave && chave.eventos.includes(eventoId)) {
    if (chave.passagem_evento_id === eventoId) return await passar(deps, ctx, chave);
    return await talvezNota(deps, ctx, cfg, chave, agora, janelaMs, null);
  }

  // ── A avaliação, ANTES de qualquer decisão ───────────────────────────────
  const mensagens = await deps.db.ultimasMensagens(
    orgId,
    ctx.conversationId,
    MENSAGENS_DA_AVALIACAO,
  );
  const { idioma } = await deps.marca(orgId);
  const avaliacao = await deps.avaliar({
    organizationId: orgId,
    conversationId: ctx.conversationId,
    idioma,
    motivoCodigo: MOTIVO,
    mensagens,
    situacao: "tom_aspero",
  });
  const hipotese = avaliacao.disponivel ? avaliacao.hipotese : null;
  const confianca = avaliacao.disponivel ? avaliacao.confianca : null;
  const agoraIso = agora.toISOString();

  // ── Primeira irritação (ou a anterior venceu): registra e NÃO passa ──────
  if (!chave || !dentroDaJanela(chave.ultima_em, agora, janelaMs)) {
    const nova: ChaveDaTolerancia = {
      versao: (chave?.versao ?? 0) + 1,
      primeira_em: agoraIso,
      ultima_em: agoraIso,
      evento_id: eventoId,
      eventos: [eventoId],
      hipotese,
      confianca,
      nota_evento_id: null,
      nota_em: null,
      passagem_evento_id: null,
    };
    if (!(await deps.db.gravaChave(orgId, ctx.conversationId, chave?.versao ?? null, nova))) {
      return disputa(agora);
    }
    return await talvezNota(deps, ctx, cfg, nova, agora, janelaMs, mensagens);
  }

  // ── Segunda irritação na janela ──────────────────────────────────────────
  const renovada: ChaveDaTolerancia = {
    ...chave,
    versao: chave.versao + 1,
    ultima_em: agoraIso,
    evento_id: eventoId,
    eventos: [...chave.eventos, eventoId].slice(-TETO_DE_EVENTOS_CONTADOS),
    hipotese,
    confianca,
  };
  if (segundaIrritacaoPassa(avaliacao)) {
    const reivindicada: ChaveDaTolerancia = { ...renovada, passagem_evento_id: eventoId };
    if (!(await deps.db.gravaChave(orgId, ctx.conversationId, chave.versao, reivindicada))) {
      return disputa(agora);
    }
    return await passar(deps, ctx, reivindicada);
  }
  if (!(await deps.db.gravaChave(orgId, ctx.conversationId, chave.versao, renovada))) {
    return disputa(agora);
  }
  return await talvezNota(deps, ctx, cfg, renovada, agora, janelaMs, mensagens);
}

function disputa(agora: Date): DesfechoDaTolerancia {
  return retry(
    new Date(agora.getTime() + ADIAMENTO_DA_DISPUTA_MS),
    "tolerancia: outra irritação desta conversa está sendo contada",
  );
}

/** A passagem do upstream, e então a chave sai da conversa. */
async function passar(
  deps: ToleranciaDeps,
  ctx: ContextoDaTolerancia,
  chave: ChaveDaTolerancia,
): Promise<DesfechoDaTolerancia> {
  const r = await deps.passar(ctx.passagem);
  try {
    await deps.db.gravaChave(ctx.row.organization_id, ctx.conversationId, chave.versao, null);
  } catch (err) {
    // A conversa já passou: o gate recusa a próxima volta, e a chave velha
    // vence pela janela. Nada a desfazer.
    logger.warn("[tolerancia] chave não saiu depois da passagem", {
      conversation_id: ctx.conversationId,
      causa: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
  }
  return { status: r.triggered ? "ok" : "skipped", detail: r.reason };
}

/**
 * A nota curta ao dono, quando a hipótese pede. NUNCA lança: a irritação já
 * está registrada, e uma falha aqui não pode virar passagem.
 */
async function talvezNota(
  deps: ToleranciaDeps,
  ctx: ContextoDaTolerancia,
  cfg: ConfigDoAvisoDePassagem,
  chave: ChaveDaTolerancia,
  agora: Date,
  janelaMs: number,
  lidas: readonly MensagemDaTolerancia[] | null,
): Promise<DesfechoDaTolerancia> {
  const orgId = ctx.row.organization_id;
  try {
    if (!chave.hipotese || !HIPOTESES_COM_NOTA.has(chave.hipotese)) return seguiu("sem_nota");
    if (chave.nota_evento_id === ctx.row.id) return seguiu("nota_ja_enviada");
    if (dentroDaJanela(chave.nota_em, agora, janelaMs)) return seguiu("nota_recente");
    if (!cfg.ligado || !cfg.aviso_de_passagem_ligado || !cfg.channel_session_id) {
      return seguiu("aviso_desligado");
    }
    if (passouDoTeto(ctx.row, agora)) return seguiu("evento_velho");
    const channelSessionId = cfg.channel_session_id;

    // A prontidão do canal, como no aviso de passagem — mas aqui sem linha de
    // entrega nem tentativa: a nota que não pode sair agora simplesmente não sai.
    const envio = await deps.envio();
    const canal = await envio.canais.carregaCanal(orgId, channelSessionId);
    if (!canal || canal.archived_at || canal.desativado || !canal.aceitaMensagemLivre) {
      return seguiu("canal_indisponivel");
    }
    if (canal.status !== "WORKING") return seguiu("canal_desconectado");
    if (!urlPublicaUsavel(envio.urlPublica)) return seguiu("sem_endereco_publico");
    if (!(await envio.transporte.configurado(orgId, canal))) return seguiu("transporte_ausente");
    const pacing = await envio.pacing.decide(orgId, channelSessionId, agora);
    if (!pacing.liberado) {
      // Espaçamento: volta quando libera (a repetição não conta a irritação de
      // novo). Teto diário: a nota de amanhã já não diz nada.
      if (pacing.motivo === "teto_diario") return seguiu("teto_diario_do_numero");
      return retry(pacing.liberaEm, "tolerancia: nota aguardando o espaçamento do número");
    }
    if (await envio.canais.destinoEhDaPropriaOrganizacao(orgId, cfg.telefone_destino)) {
      return seguiu("destino_da_propria_organizacao");
    }
    const to = await envio.transporte.resolveDestino(orgId, canal, cfg.telefone_destino);
    if (!to) return seguiu("destino_invalido");

    const mensagens =
      lidas ?? (await deps.db.ultimasMensagens(orgId, ctx.conversationId, MENSAGENS_DA_AVALIACAO));
    const [marca, nome] = await Promise.all([
      deps.marca(orgId),
      ctx.contactId ? envio.canais.nomeDoContato(orgId, ctx.contactId) : Promise.resolve(null),
    ]);
    const nota = montarNotaDeTomAspero({
      marca: marca.nome,
      idioma: marca.idioma,
      nomeDoCliente: nome,
      mensagem: trechoDoAlerta(mensagens, ctx.messageId),
      avaliacao: { hipotese: chave.hipotese, confianca: chave.confianca ?? 0 },
      link: linkDaConversa(envio.urlPublica, ctx.conversationId),
    });

    // REIVINDICA antes de enviar: a repetição deste evento não manda de novo.
    const reivindicada: ChaveDaTolerancia = {
      ...chave,
      versao: chave.versao + 1,
      nota_evento_id: ctx.row.id,
      nota_em: agora.toISOString(),
    };
    if (!(await deps.db.gravaChave(orgId, ctx.conversationId, chave.versao, reivindicada))) {
      return seguiu("nota_disputada");
    }
    await enviarParte({
      transporte: envio.transporte,
      pacing: envio.pacing,
      organizationId: orgId,
      canal,
      channelSessionId,
      to,
      partes: [nota],
      jaEnviadas: 0,
      agora,
    });
    try {
      await envio.canais.registraJidDoAviso(orgId, to);
    } catch (err) {
      logger.warn("[tolerancia] JID do destino não registrado", {
        organizationId: orgId,
        causa: err instanceof Error ? err.message : String(err),
      });
    }
    return seguiu("nota_enviada");
  } catch (err) {
    logger.warn("[tolerancia] nota ao dono não saiu", {
      organizationId: orgId,
      conversation_id: ctx.conversationId,
      causa: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return seguiu("nota_falhou");
  }
}

// ---------------------------------------------------------------------------
// Adapter de produção — `ToleranciaDb` e as dependências sobre o service role.
// ---------------------------------------------------------------------------

/**
 * ⚠️ TODA consulta filtra `organization_id` À MÃO: o client é o de service
 * role, que BYPASSA a RLS. A organização vem da linha do `event_log`.
 */
export function createSupabaseToleranciaDb(
  admin: SupabaseClient,
  carregaConfig: ToleranciaDb["carregaConfig"],
): ToleranciaDb {
  return {
    carregaConfig,

    async carregaConversa(orgId, conversationId) {
      const { data, error } = await admin
        .from("conversations")
        .select(
          "metadata, is_group, assignee_kind, assigned_to_user_id, contacts:contact_id(is_personal, is_blocked, is_anonymized)",
        )
        .eq("organization_id", orgId)
        .eq("id", conversationId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const c = data as unknown as {
        metadata: Record<string, unknown> | null;
        is_group: boolean | null;
        assignee_kind: string | null;
        assigned_to_user_id: string | null;
        contacts: {
          is_personal: boolean | null;
          is_blocked: boolean | null;
          is_anonymized: boolean | null;
        } | null;
      };
      return {
        metadata: c.metadata,
        is_group: Boolean(c.is_group),
        assignee_kind: c.assignee_kind,
        assigned_to_user_id: c.assigned_to_user_id,
        contato: c.contacts
          ? {
              is_personal: Boolean(c.contacts.is_personal),
              is_blocked: Boolean(c.contacts.is_blocked),
              is_anonymized: Boolean(c.contacts.is_anonymized),
            }
          : null,
      };
    },

    async gravaChave(orgId, conversationId, esperada, nova) {
      const { data: lida, error: erroDaLeitura } = await admin
        .from("conversations")
        .select("metadata")
        .eq("organization_id", orgId)
        .eq("id", conversationId)
        .maybeSingle();
      if (erroDaLeitura) throw new Error(erroDaLeitura.message);
      if (!lida) return false;
      const metadata = ((lida as { metadata: Record<string, unknown> | null }).metadata ??
        {}) as Record<string, unknown>;
      if ((lerChave(metadata)?.versao ?? null) !== esperada) return false;
      const { [CHAVE_DA_TOLERANCIA]: _fora, ...resto } = metadata;
      const proximo = nova ? { ...resto, [CHAVE_DA_TOLERANCIA]: nova } : resto;
      const filtro = `metadata->${CHAVE_DA_TOLERANCIA}->>versao`;
      const base = admin
        .from("conversations")
        .update({ metadata: proximo })
        .eq("organization_id", orgId)
        .eq("id", conversationId);
      const { data, error } = await (
        esperada === null ? base.is(filtro, null) : base.eq(filtro, String(esperada))
      ).select("id");
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    },

    async ultimasMensagens(orgId, conversationId, limite) {
      const { data, error } = await admin
        .from("messages")
        .select("id, direction, sent_via, body, media_derived_text, metadata, created_at")
        .eq("organization_id", orgId)
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(limite);
      if (error) throw new Error(error.message);
      return (data ?? []) as MensagemDaTolerancia[];
    },
  };
}

/**
 * A tolerância de produção, pronta para o handler: monta as dependências e
 * aplica. Qualquer falha AO MONTAR também vira `null` — a passagem de sempre.
 */
export async function aplicaToleranciaDeProducao(
  admin: SupabaseClient,
  ctx: ContextoDaTolerancia,
): Promise<DesfechoDaTolerancia | null> {
  try {
    const [
      { createSupabaseAvisoDePassagemDb },
      { createSupabaseAvisoDb },
      { avaliarPassagem, criarDepsDaAvaliacao },
      { decidirElegibilidadeDaConversaViaSupabase },
      { ttlDaAutorizacaoMs },
      { triggerHandoff },
      { origemDoDreno },
    ] = await Promise.all([
      import("./aviso-de-passagem-ao-suporte"),
      import("./aviso-ao-suporte"),
      import("./avaliacao-da-passagem"),
      import("@/lib/ai/elegibilidade/consulta-supabase"),
      import("@/lib/ai/elegibilidade/gate"),
      import("@/lib/ai/handoff/orchestrator"),
      import("@/lib/event-log/origem-do-dreno"),
    ]);
    const avisoDb = createSupabaseAvisoDb(admin);
    const deps: ToleranciaDeps = {
      db: createSupabaseToleranciaDb(admin, (orgId) =>
        createSupabaseAvisoDePassagemDb(admin).carregaConfig(orgId),
      ),
      marca: (orgId) => avisoDb.marcaDaOrganizacao(orgId),
      async elegivel(orgId, conversationId, agora) {
        const d = await decidirElegibilidadeDaConversaViaSupabase(admin, {
          organizationId: orgId,
          conversationId,
          agora,
          ttlMs: ttlDaAutorizacaoMs(process.env),
        });
        return d !== null && d.permite;
      },
      // A avaliação monta gateway, orçamento e log só se for chamada.
      avaliar: async (entrada) => avaliarPassagem(await criarDepsDaAvaliacao(), entrada),
      passar: (input) => triggerHandoff(input),
      async envio() {
        const [{ criarTransporteDoAviso }, { criarPacingDoCanal }, { env }] = await Promise.all([
          import("./aviso-ao-suporte.handler"),
          import("@/lib/agent-engine/pacing/ledger-supabase"),
          import("@/lib/env"),
        ]);
        return {
          canais: avisoDb,
          transporte: await criarTransporteDoAviso(admin),
          pacing: await criarPacingDoCanal(admin),
          urlPublica: env.NEXT_PUBLIC_APP_URL,
        };
      },
      clock: () => new Date(),
      origemDoDreno,
    };
    return await aplicaToleranciaAoSentimento(deps, ctx);
  } catch (err) {
    logger.warn("[tolerancia] dependências não montaram — a passagem segue como no upstream", {
      conversation_id: ctx.conversationId,
      causa: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return null;
  }
}
