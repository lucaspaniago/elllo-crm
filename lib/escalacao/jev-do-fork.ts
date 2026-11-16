/**
 * O JEV NO FORK — uma porta só para as três perguntas que o dono pediu
 * (fork elllo, 16/11/2026):
 *
 *   - o tom áspero (`./avaliacao-pelo-jev.ts`): brincadeira, irritação real,
 *     engano, propaganda ou outro;
 *   - a propaganda que a forma do disparo não denuncia
 *     (`silenciarDisparoAutomatico`, o silêncio de propaganda);
 *   - a mensagem de grupo que vale a resposta do dono
 *     (`./grupo-pelo-jev.handler.ts`).
 *
 * ## Por que não é uma tarefa em `lib/ai/decisao/tarefas.ts`
 *
 * As tarefas do autor nunca calam, bloqueiam nem respondem — é a cerca daquele
 * diretório. Estas três calam (propaganda) e escolhem o que o dono lê, por
 * decisão dele. Pôr aqui, e não lá, também mantém o rebase semanal longe do
 * registro de tarefas, do cartão e da tela.
 *
 * ## O que é reaproveitado do autor, de propósito
 *
 *   - **A chave e o consentimento:** a chamada sai por `decidirNoPonto` no
 *     ponto do clima (`sentiment_classify`). Ela só lê a chave com o Jev ligado,
 *     o aceite do administrador cobrindo "cada mensagem" e a tarefa do clima
 *     não desligada — desligar o Jev na tela desliga estas três junto. A chave
 *     é a da organização ("BYOK"), nunca uma de ambiente.
 *   - **A allowlist de egress e o teto de tempo** (`TETO_PADRAO_MS`) do ponto.
 *   - **O disjuntor** (`lib/ai/decisao/disjuntor.ts`), por organização e por
 *     propósito.
 *   - **A linha em `llm_calls`**, com `provider = 'typesafe'` e o custo
 *     fracionário de `costCents` — é ela que mede o teto do dia e aparece em
 *     IA › Execuções.
 *
 * ## O teto do dia
 *
 * `settings.crm.jev_do_fork.teto_diario_usd` (padrão US$ 0,50): a soma do que
 * estas três perguntas custaram nas últimas 24 h. Passou, nada sai para a
 * rede até a soma baixar, e cada chamador segue pelo caminho de hoje. É uma
 * janela móvel de 24 h, e não o dia do calendário: dispensa o fuso e nunca
 * libera de uma vez à meia-noite.
 *
 * ## Os interruptores
 *
 * `settings.crm.jev_do_fork.{avaliacao, propaganda, grupos, apanhado}`, todos
 * ligados por padrão (pedido do dono). `false` desliga só aquela parte, sem
 * imagem nova. Valor ilegível vale LIGADO — o mesmo padrão de
 * `silenciar_disparos_automaticos`; quem quer desligar escreve `false`.
 *
 * Nunca lança: toda ausência volta como `{ ok: false, motivo }`, e o chamador
 * segue pelo caminho de hoje.
 */
import { z } from "zod";

import type { Pergunta, Resposta, ResultadoDaDecisao } from "@/lib/ai/decisao/cliente";
import type { MotivoDaAusencia } from "@/lib/ai/decisao/cliente";
import { podeTentar, registrarFalha, registrarSucesso } from "@/lib/ai/decisao/disjuntor";
import { logger } from "@/lib/logger";
import type { SupabaseClient } from "@supabase/supabase-js";

/** O `purpose` de cada pergunta em `llm_calls` — o teto do dia soma estes três. */
export const PROPOSITOS_DO_JEV_DO_FORK = {
  tom: "elllo_jev_tom",
  propaganda: "elllo_jev_propaganda",
  grupo: "elllo_jev_grupo",
} as const;
export type PropositoDoJevDoFork = (typeof PROPOSITOS_DO_JEV_DO_FORK)[keyof typeof PROPOSITOS_DO_JEV_DO_FORK];

/** O ponto cujo consentimento e cuja chave estas perguntas usam. */
export const PONTO_DO_JEV_DO_FORK = "sentiment_classify";

export const TETO_DIARIO_PADRAO_USD = 0.5;

const configSchema = z
  .object({
    avaliacao: z.boolean().catch(true),
    propaganda: z.boolean().catch(true),
    grupos: z.boolean().catch(true),
    apanhado: z.boolean().catch(true),
    teto_diario_usd: z.number().min(0).max(20).catch(TETO_DIARIO_PADRAO_USD),
  })
  .catch({ avaliacao: true, propaganda: true, grupos: true, apanhado: true, teto_diario_usd: TETO_DIARIO_PADRAO_USD });

export type ConfigDoJevDoFork = z.infer<typeof configSchema>;
export type ParteDoJevDoFork = "avaliacao" | "propaganda" | "grupos" | "apanhado";

/** `organizations.settings.crm.jev_do_fork`, lido sem nunca lançar. */
export function lerJevDoFork(settings: unknown): ConfigDoJevDoFork {
  const crm =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>).crm
      : undefined;
  const bloco =
    crm && typeof crm === "object" && !Array.isArray(crm)
      ? (crm as Record<string, unknown>).jev_do_fork
      : undefined;
  return configSchema.parse(bloco ?? {});
}

export type ResultadoDoJevDoFork =
  | {
      ok: true;
      respostas: Record<string, Resposta>;
      latenciaMs: number;
      /** Fracionário (o Jev custa frações de centavo). `null` = versão sem preço na tabela. */
      custoCentavos: number | null;
      modelo: string;
    }
  | { ok: false; motivo: MotivoDaAusencia | "teto_diario" | "erro" };

export interface LinhaDoJevDoFork {
  organization_id: string;
  contact_id: string | null;
  purpose: PropositoDoJevDoFork;
  model: string;
  input_tokens: number;
  latency_ms: number | null;
  cost_cents: number | null;
  status: "ok" | "erro";
  error_code: string | null;
  http_status: number | null;
}

export interface DepsDoJevDoFork {
  /** O que estas perguntas custaram, em centavos, desde `desde`. */
  gastoEmCentavos(organizationId: string, desde: Date): Promise<number>;
  /** A chamada — em produção, `decidirNoPonto` no ponto do clima. */
  perguntar(entrada: {
    organizationId: string;
    estado: Record<string, unknown>;
    perguntas: Record<string, Pergunta>;
    tetoMs?: number;
  }): Promise<ResultadoDaDecisao>;
  custoCentavos(modelo: string, tokensDeEntrada: number): number | null;
  /** A linha em `llm_calls`. Falha aqui é log, nunca derruba a resposta. */
  registrar(linha: LinhaDoJevDoFork): Promise<void>;
  agora(): Date;
}

export interface PerguntaDoFork {
  organizationId: string;
  contactId: string | null;
  proposito: PropositoDoJevDoFork;
  estado: Record<string, unknown>;
  perguntas: Record<string, Pergunta>;
  tetoDiarioUsd: number;
  tetoMs?: number;
}

const UM_DIA_MS = 24 * 60 * 60 * 1000;

/** Pergunta ao Jev com o teto do dia, o disjuntor e o registro. Nunca lança. */
export async function perguntarAoJevDoFork(
  deps: DepsDoJevDoFork,
  p: PerguntaDoFork,
): Promise<ResultadoDoJevDoFork> {
  const alvo = { organizationId: p.organizationId, tarefa: p.proposito };
  try {
    const agora = deps.agora();
    if (!podeTentar(alvo, agora.getTime())) return { ok: false, motivo: "disjuntor_aberto" };
    const gasto = await deps.gastoEmCentavos(p.organizationId, new Date(agora.getTime() - UM_DIA_MS));
    if (gasto >= p.tetoDiarioUsd * 100) return { ok: false, motivo: "teto_diario" };

    const r = await deps.perguntar({
      organizationId: p.organizationId,
      estado: p.estado,
      perguntas: p.perguntas,
      ...(p.tetoMs !== undefined ? { tetoMs: p.tetoMs } : {}),
    });
    if (!r.ok) {
      registrarFalha(alvo, r.motivo, agora.getTime(), r.retryAfterMs);
      // Só o que saiu para a rede vira linha (o "sem chave" é configuração).
      if (r.motivo !== "sem_credencial" && r.motivo !== "disjuntor_aberto") {
        await registrarSemLancar(deps, {
          organization_id: p.organizationId,
          contact_id: p.contactId,
          purpose: p.proposito,
          model: "typesafe/jev",
          input_tokens: 0,
          latency_ms: r.latenciaMs ?? null,
          cost_cents: 0,
          status: "erro",
          error_code: `jev_${r.motivo}`,
          http_status: r.status,
        });
      }
      return { ok: false, motivo: r.motivo };
    }
    registrarSucesso(alvo);
    const custo = deps.custoCentavos(r.modelo, r.uso.tokensDeEntrada);
    await registrarSemLancar(deps, {
      organization_id: p.organizationId,
      contact_id: p.contactId,
      purpose: p.proposito,
      model: `typesafe/${r.modelo}`,
      input_tokens: r.uso.tokensDeEntrada,
      latency_ms: r.latenciaMs,
      cost_cents: custo,
      status: "ok",
      error_code: null,
      http_status: null,
    });
    return { ok: true, respostas: r.respostas, latenciaMs: r.latenciaMs, custoCentavos: custo, modelo: r.modelo };
  } catch (err) {
    logger.warn("[jev-do-fork] pergunta não saiu; seguindo pelo caminho de hoje", {
      organization_id: p.organizationId,
      proposito: p.proposito,
      erro: err instanceof Error ? err.name : typeof err,
    });
    return { ok: false, motivo: "erro" };
  }
}

async function registrarSemLancar(deps: DepsDoJevDoFork, linha: LinhaDoJevDoFork): Promise<void> {
  try {
    await deps.registrar(linha);
  } catch (err) {
    logger.warn("[jev-do-fork] linha em llm_calls não gravada", {
      organization_id: linha.organization_id,
      erro: err instanceof Error ? err.message.slice(0, 160) : String(err),
    });
  }
}

/** A probabilidade de "sim" de um Noul, ou `null` quando a resposta não veio nesse formato. */
export function probabilidadeDoNoul(respostas: Record<string, Resposta>, id: string): number | null {
  const r = respostas[id];
  return r && r.tipo === "noul" && Number.isFinite(r.noul) ? Math.min(1, Math.max(0, r.noul)) : null;
}

// ---------------------------------------------------------------------------
// Adapter de produção. Imports TARDIOS: o topo carrega sem ambiente.
// ---------------------------------------------------------------------------

/** As dependências de verdade, sobre o service role. Toda consulta filtra a organização. */
export async function criarDepsDoJevDoFork(admin: SupabaseClient): Promise<DepsDoJevDoFork> {
  const [{ decidirNoPonto }, { costCents }] = await Promise.all([
    import("@/lib/ai/decisao/ponto"),
    import("@/lib/agent-engine/edge/llm/pricing"),
  ]);
  const propositos = Object.values(PROPOSITOS_DO_JEV_DO_FORK);
  return {
    async gastoEmCentavos(organizationId, desde) {
      const { data, error } = await admin
        .from("llm_calls")
        .select("cost_cents")
        .eq("organization_id", organizationId)
        .eq("provider", "typesafe")
        .in("purpose", propositos)
        .gte("created_at", desde.toISOString())
        .limit(20_000);
      if (error) throw new Error(error.message);
      return ((data ?? []) as Array<{ cost_cents: number | null }>).reduce(
        (soma, l) => soma + (typeof l.cost_cents === "number" ? l.cost_cents : 0),
        0,
      );
    },
    perguntar: ({ organizationId, estado, perguntas, tetoMs }) =>
      decidirNoPonto({
        // Literal de propósito: a cerca dos pontos de IA lê o ponto na chamada.
        ponto: "sentiment_classify",
        organizationId,
        estado,
        perguntas,
        ...(tetoMs !== undefined ? { tetoMs } : {}),
      }),
    custoCentavos: (modelo, tokens) =>
      costCents(modelo, { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    async registrar(linha) {
      const { error } = await admin.from("llm_calls").insert({
        ...linha,
        output_tokens: 0,
        origem_da_escolha: "jev",
      });
      if (error) throw new Error(error.message);
    },
    agora: () => new Date(),
  };
}

/** `settings` da organização, lido pelo service role. Falha = `null` (vale o padrão). */
export async function settingsDaOrganizacao(admin: SupabaseClient, organizationId: string): Promise<unknown> {
  const { data, error } = await admin.from("organizations").select("settings").eq("id", organizationId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { settings?: unknown } | null)?.settings ?? null;
}
