/**
 * A AVALIAÇÃO DA PASSAGEM — o que a IA acha que aconteceu (fork elllo).
 *
 * ## O que este arquivo é
 *
 * Uma chamada curta ao modelo, feita UMA vez por aviso de passagem ao dono
 * (`./aviso-de-passagem-ao-suporte.ts`, na primeira parte), que lê as últimas
 * mensagens da conversa e devolve uma hipótese — brincadeira, irritação real,
 * engano ou outro — com a confiança, até três indícios, uma recomendação e uma
 * linha de contexto. É o que deixa o dono decidir do celular se precisa largar
 * o que está fazendo.
 *
 * ## As decisões, cada uma com o motivo
 *
 * **O ponto de IA é o do clima, `sentiment_classify`.** Decisão do dono: a
 * avaliação é a mesma família de pergunta que a medição do clima, e um ponto
 * novo no painel seria mais um modelo a escolher sem ganho. Por isso o modelo
 * é resolvido por `resolverModeloDoPonto("sentiment_classify", …,
 * DEFAULT_CLASSIFIER_MODEL, { naFaltaUsarOPadraoDaOrganizacao: true })`, o
 * orçamento é o de `podeGastarComIa(org, "sentiment_classify")` e a linha em
 * `llm_calls` sai com `invocation_kind: "sentiment_classify"` — como em
 * `workers/ai-sentiment-worker.ts`. O que distingue esta chamada na tela de
 * Execuções é a conversa e o horário, não o ponto.
 *
 * **Nunca lança, nunca segura o aviso.** Orçamento estourado, modelo ausente,
 * timeout, JSON fora do contrato: tudo vira `{ disponivel: false }`, e o aviso
 * sai com "Avaliação indisponível". O aviso é o efeito; a avaliação é enfeite
 * útil dele.
 *
 * **Tudo o que o modelo escreve passa por `sanitizarTextoDoLead`.** O modelo lê
 * a fala do cliente e pode devolvê-la: um link, um CPF ou um telefone escritos
 * pelo cliente não podem sair daqui dentro de uma mensagem com a marca da
 * empresa.
 *
 * **O texto do modelo NUNCA é guardado.** Só a hipótese vai para o banco
 * (`entregas_de_aviso_de_passagem.hipotese`); o resto vive no aviso e morre nele.
 *
 * **NÃO mora em `lib/ai/decisao/**`** — aquele diretório é do Jev, com cercas
 * próprias (ele nunca cala, bloqueia nem responde); esta chamada não é dele.
 *
 * O núcleo é PURO (dependências injetadas) e o adapter de produção, no fim,
 * importa o gateway, o orçamento e o log de forma TARDIA — o topo deste arquivo
 * carrega sem ambiente, como `./aviso-ao-suporte.ts`.
 */
import { z } from "zod";

import type { Idioma } from "@/lib/i18n/idiomas";
import { idiomaVisivelPorCodigo } from "@/lib/i18n/registro";
import { MENSAGEM_REDIGIDA } from "@/lib/lgpd/cascata";
import { logger } from "@/lib/logger";

import { sanitizarTextoDoLead } from "./sanitizar-texto-do-lead";
import { FRASE_DO_MOTIVO, type MotivoDaPassagem } from "./passagem";
import { TETOS_DA_AVALIACAO, type AvaliacaoParaOAviso } from "./texto-do-aviso-de-passagem";
import { HIPOTESES_DA_PASSAGEM } from "./vocabulario-do-aviso-de-passagem";

/** O ponto de IA — o MESMO literal do worker de clima. */
export const PONTO_DA_AVALIACAO = "sentiment_classify";
/** Quantas mensagens o modelo lê. */
export const MENSAGENS_DA_AVALIACAO = 12;
/** O teto de espera — o aviso não espera mais que isso pela avaliação. */
export const TIMEOUT_DA_AVALIACAO_MS = 8_000;
/**
 * Teto de saída. `generateObject` com Anthropic usa modo ferramenta, que custa
 * mais que texto puro (medido em `workers/ai-sentiment-worker.ts`: 80 cortava o
 * JSON no meio). Cinco campos curtos cabem com folga.
 */
export const TETO_DE_SAIDA_DA_AVALIACAO = 300;
/** Teto de cada fala na transcrição enviada ao modelo. */
const TETO_DA_FALA = 400;

/** O contrato da avaliação, já limpa — o que o aviso recebe. */
export const avaliacaoDaPassagemSchema = z.object({
  hipotese: z.enum(HIPOTESES_DA_PASSAGEM),
  confianca: z.number().min(0).max(1),
  indicios: z.array(z.string().min(1).max(TETOS_DA_AVALIACAO.indicio)).max(3),
  recomendacao: z.string().min(1).max(TETOS_DA_AVALIACAO.recomendacao).nullable(),
  contexto: z.string().min(1).max(TETOS_DA_AVALIACAO.contexto).nullable(),
});

/**
 * O que o MODELO preenche. Tetos largos de propósito: estourar um teto aqui
 * derrubaria a avaliação inteira por uma frase comprida — quem corta no tamanho
 * certo é `normalizar`, com reticências.
 */
export const respostaDoModeloSchema = z.object({
  hipotese: z
    .enum(HIPOTESES_DA_PASSAGEM)
    .describe("brincadeira | irritacao_real | engano | outro"),
  confianca: z.number().min(0).max(1).describe("0 a 1: quão segura é a hipótese"),
  indicios: z.array(z.string().max(400)).max(5).describe("até 3 indícios curtos, ≤140 caracteres cada"),
  recomendacao: z.string().max(600).describe("o que o dono deveria fazer agora, ≤200 caracteres"),
  contexto: z.string().max(800).describe("o assunto da conversa em uma linha, ≤240 caracteres"),
});

export type ResultadoDaAvaliacao =
  | ({ disponivel: true } & AvaliacaoParaOAviso)
  | { disponivel: false; porque: string };

/** Uma mensagem da conversa, do jeito que o adapter a lê. */
export interface MensagemParaAvaliar {
  direction: string;
  sent_via: string | null;
  body: string | null;
  media_derived_text?: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/** Quem falou, do ponto de vista de quem lê a transcrição. */
function rotulo(m: MensagemParaAvaliar): string {
  if (m.direction === "inbound") return "cliente";
  if (m.metadata?.aviso_de_escalacao === true) return "[aviso]";
  return m.sent_via === "ai" ? "IA" : "equipe";
}

/**
 * A transcrição marcada, da mais antiga para a mais nova.
 *
 * Pula a mensagem redigida pela LGPD (o rótulo não é fala de ninguém) e usa o
 * texto derivado da mídia (transcrição do áudio, descrição da imagem) quando o
 * corpo está vazio. Recebe as mensagens em QUALQUER ordem e ordena por data.
 */
export function montarTranscricao(mensagens: readonly MensagemParaAvaliar[]): string {
  return [...mensagens]
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .slice(-MENSAGENS_DA_AVALIACAO)
    .map((m) => {
      const corpo = (m.body ?? "").trim();
      const texto = corpo !== "" ? corpo : (m.media_derived_text ?? "").trim();
      if (texto === "" || texto === MENSAGEM_REDIGIDA) return null;
      const curto = [...texto.replace(/\s+/g, " ")].slice(0, TETO_DA_FALA).join("");
      return `${rotulo(m)}: ${curto}`;
    })
    .filter((l): l is string => l !== null)
    .join("\n");
}

/** O prompt de sistema. Exportado para o teste prender o que ele exige. */
export function promptDaAvaliacao(idioma: Idioma): string {
  const lingua = idiomaVisivelPorCodigo(idioma).nomeNativo;
  return `Você ajuda o dono de uma pequena empresa a entender por que o atendimento automático passou uma conversa de WhatsApp para uma pessoa.

Leia a transcrição (as falas estão marcadas como cliente, IA, equipe e [aviso]) e o motivo da passagem, e responda com:
- "hipotese": "brincadeira" (o cliente brincou, ironizou ou exagerou sem irritação de verdade), "irritacao_real" (há insatisfação real e alguém precisa agir), "engano" (a passagem foi um equívoco: mensagem mal lida, contexto que a IA não tinha) ou "outro";
- "confianca": de 0 a 1;
- "indicios": até 3 indícios curtos que sustentam a hipótese;
- "recomendacao": o que o dono deveria fazer agora, numa frase;
- "contexto": o assunto da conversa, numa linha.

Regras: não copie dados pessoais (telefone, documento, e-mail, endereço, links); não cite palavrões; seja neutro e breve. Escreva indícios, recomendação e contexto em ${lingua}.`;
}

export interface DepsDaAvaliacao {
  /** `null` = nenhum modelo disponível para o ponto nesta organização. */
  resolverModelo(organizationId: string): Promise<{ model: unknown; modelId: string } | null>;
  podeGastar(organizationId: string): Promise<boolean>;
  gerar(entrada: {
    model: unknown;
    system: string;
    prompt: string;
    abortSignal: AbortSignal;
  }): Promise<{ object: unknown; promptTokens: number; completionTokens: number }>;
  custo(entrada: { model: string; promptTokens: number; completionTokens: number }): Promise<number>;
  /** Fire-and-forget: a linha em `llm_calls`. */
  registrar(linha: {
    organization_id: string;
    conversation_id: string | null;
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
    latency_ms: number;
    cost_cents: number;
    finish_reason: string | null;
    error_payload?: Record<string, unknown> | null;
  }): void;
  agora(): number;
}

/** Corta e limpa o que o modelo devolveu, e só então confere o contrato. */
export function normalizar(bruto: unknown): AvaliacaoParaOAviso | null {
  const r = respostaDoModeloSchema.safeParse(bruto);
  if (!r.success) return null;
  const limpo = {
    hipotese: r.data.hipotese,
    confianca: r.data.confianca,
    indicios: r.data.indicios
      .map((i) => sanitizarTextoDoLead(i, TETOS_DA_AVALIACAO.indicio))
      .filter((i): i is string => i !== null)
      .slice(0, 3),
    recomendacao: sanitizarTextoDoLead(r.data.recomendacao, TETOS_DA_AVALIACAO.recomendacao),
    contexto: sanitizarTextoDoLead(r.data.contexto, TETOS_DA_AVALIACAO.contexto),
  };
  const final = avaliacaoDaPassagemSchema.safeParse(limpo);
  return final.success ? final.data : null;
}

/**
 * Avalia a passagem. Nunca lança.
 *
 * A ordem é a do worker de clima: o modelo, o orçamento ANTES da chamada paga,
 * a chamada com teto de tempo, a linha em `llm_calls` (também na falha).
 */
export async function avaliarPassagem(
  deps: DepsDaAvaliacao,
  entrada: {
    organizationId: string;
    conversationId: string | null;
    idioma: Idioma;
    motivoCodigo: MotivoDaPassagem;
    mensagens: readonly MensagemParaAvaliar[];
  },
): Promise<ResultadoDaAvaliacao> {
  try {
    const transcricao = montarTranscricao(entrada.mensagens);
    if (transcricao === "") return { disponivel: false, porque: "sem_mensagens" };

    const resolvido = await deps.resolverModelo(entrada.organizationId);
    if (!resolvido) return { disponivel: false, porque: "sem_modelo" };
    if (!(await deps.podeGastar(entrada.organizationId))) {
      return { disponivel: false, porque: "orcamento_de_ia" };
    }

    const prompt = `Motivo da passagem: ${FRASE_DO_MOTIVO[entrada.motivoCodigo]}\n\nTranscrição:\n${transcricao}`;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_DA_AVALIACAO_MS);
    const inicio = deps.agora();
    const comum = {
      organization_id: entrada.organizationId,
      conversation_id: entrada.conversationId,
      model: resolvido.modelId,
    };
    try {
      const gerado = await deps.gerar({
        model: resolvido.model,
        system: promptDaAvaliacao(entrada.idioma),
        prompt,
        abortSignal: abort.signal,
      });
      deps.registrar({
        ...comum,
        prompt_tokens: gerado.promptTokens,
        completion_tokens: gerado.completionTokens,
        latency_ms: deps.agora() - inicio,
        cost_cents: await deps.custo({
          model: resolvido.modelId,
          promptTokens: gerado.promptTokens,
          completionTokens: gerado.completionTokens,
        }),
        finish_reason: null,
      });
      const avaliacao = normalizar(gerado.object);
      if (!avaliacao) return { disponivel: false, porque: "fora_do_contrato" };
      return { disponivel: true, ...avaliacao };
    } catch (err) {
      deps.registrar({
        ...comum,
        prompt_tokens: 0,
        completion_tokens: 0,
        latency_ms: deps.agora() - inicio,
        cost_cents: 0,
        finish_reason: "error",
        error_payload: { message: err instanceof Error ? err.message.slice(0, 300) : String(err) },
      });
      return { disponivel: false, porque: abort.signal.aborted ? "timeout" : "erro_do_modelo" };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logger.warn("[aviso-de-passagem] avaliação indisponível", {
      organizationId: entrada.organizationId,
      causa: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return { disponivel: false, porque: "erro" };
  }
}

/**
 * O adapter de produção. Imports TARDIOS: gateway, orçamento e log arrastam
 * `@/lib/env`, e o topo deste arquivo precisa carregar sem ambiente.
 */
export async function criarDepsDaAvaliacao(): Promise<DepsDaAvaliacao> {
  const [{ generateObject }, { DEFAULT_CLASSIFIER_MODEL }, { resolverModeloDoPonto }, orc, cost, log] =
    await Promise.all([
      import("ai"),
      import("@/lib/ai/gateway"),
      import("@/lib/ai/gateway-binding"),
      import("@/lib/ai/budget/pode-gastar"),
      import("@/lib/ai/cost"),
      import("@/lib/ai/log-invocation"),
    ]);
  return {
    async resolverModelo(organizationId) {
      return await resolverModeloDoPonto(PONTO_DA_AVALIACAO, organizationId, DEFAULT_CLASSIFIER_MODEL, {
        naFaltaUsarOPadraoDaOrganizacao: true,
      });
    },
    async podeGastar(organizationId) {
      return (await orc.podeGastarComIa(organizationId, PONTO_DA_AVALIACAO)).pode;
    },
    async gerar({ model, system, prompt, abortSignal }) {
      const gerado = await generateObject({
        model: model as Parameters<typeof generateObject>[0]["model"],
        schema: respostaDoModeloSchema,
        system,
        prompt,
        temperature: 0,
        maxOutputTokens: TETO_DE_SAIDA_DA_AVALIACAO,
        abortSignal,
      });
      const usage = gerado.usage as
        | { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number }
        | undefined;
      return {
        object: gerado.object,
        promptTokens: usage?.inputTokens ?? usage?.promptTokens ?? 0,
        completionTokens: usage?.outputTokens ?? usage?.completionTokens ?? 0,
      };
    },
    custo: (e) => cost.computeCost(e),
    registrar(linha) {
      log.logInvocation({
        ...linha,
        agent_id: null,
        message_id: null,
        invocation_kind: PONTO_DA_AVALIACAO,
      });
    },
    agora: () => Date.now(),
  };
}
