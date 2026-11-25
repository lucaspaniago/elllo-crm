/**
 * O AVISO AO DONO (fork elllo, 25/11/2026) — o que o modelo do CRM escreve ao abrir um caso, para o
 * dono ler no WhatsApp e responder com "pode", "ok" ou um 👍.
 *
 * O modelo manda `aviso_ao_dono: { texto, acao_proposta?, compromisso? }` no `open_human_case`. Aqui
 * isso vira três chaves PLANAS do `agent_cases.context_snapshot` (jsonb: o caso não ganha coluna), já
 * LIMPAS por `sanitizarTextoDoLead` — o banco guarda o que vai ao dono:
 *
 *   aviso_ao_dono       string ≤ 300 (o balão do aviso natural, `texto-do-aviso.ts`)
 *   aviso_acao          agendar | responder | procurar_contato | visto | decidir
 *   aviso_compromisso   { inicio (ISO COM fuso), duracao_min (5–600), titulo ≤ 120 }
 *
 * Quem lê as três: a Helô do Hermes (sessão 2), que põe o compromisso na agenda quando o dono diz
 * "pode" e responde ao caso pelo mesmo RPC do RESPONDER. O formato é um CONTRATO com ela.
 *
 * TOLERANTE de propósito: o campo é opcional, e uma parte inválida CAI sozinha sem derrubar o caso.
 * Abrir o caso é o que importa (o aviso tem molde por tipo); um compromisso sem fuso ou uma ação fora
 * da lista nunca pode ser o motivo de o pedido do cliente não chegar ao dono. Uma string solta (modelo
 * que respondeu só a frase) vale como `{ texto }`. Sem `texto`, nenhuma das três chaves é gravada.
 */
import { TETOS_DO_TEXTO_DO_LEAD, sanitizarTextoDoLead } from "./sanitizar-texto-do-lead";

export const ACOES_DO_AVISO_AO_DONO = ["agendar", "responder", "procurar_contato", "visto", "decidir"] as const;
export type AcaoDoAvisoAoDono = (typeof ACOES_DO_AVISO_AO_DONO)[number];

export interface CompromissoDoAvisoAoDono {
  /** ISO 8601 COM fuso (`2026-12-04T09:40:00-04:00`). Sem fuso não entra: a hora seria ambígua. */
  inicio: string;
  /** 5 a 600; fora disso (ou ausente) vale 60. */
  duracao_min: number;
  titulo: string;
}

/** As chaves que vão para o `context_snapshot` do caso. */
export interface CamposDoAvisoAoDono {
  aviso_ao_dono: string;
  aviso_acao?: AcaoDoAvisoAoDono;
  aviso_compromisso?: CompromissoDoAvisoAoDono;
}

export const TETO_DO_TITULO_DO_COMPROMISSO = 120;

const INICIO_COM_FUSO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function objeto(bruto: unknown): Record<string, unknown> | null {
  return typeof bruto === "object" && bruto !== null && !Array.isArray(bruto) ? (bruto as Record<string, unknown>) : null;
}

function compromisso(bruto: unknown): CompromissoDoAvisoAoDono | null {
  const c = objeto(bruto);
  if (c === null) return null;
  const inicio = typeof c.inicio === "string" ? c.inicio.trim() : "";
  if (!INICIO_COM_FUSO.test(inicio) || Number.isNaN(Date.parse(inicio))) return null;
  const titulo = sanitizarTextoDoLead(typeof c.titulo === "string" ? c.titulo : null, TETO_DO_TITULO_DO_COMPROMISSO);
  if (!titulo) return null;
  const d = typeof c.duracao_min === "number" ? c.duracao_min : Number(c.duracao_min);
  const duracao_min = Number.isFinite(d) && d >= 5 && d <= 600 ? Math.round(d) : 60;
  return { inicio, duracao_min, titulo };
}

/** Normaliza o que o modelo mandou. `null` quando não sobra texto — aí o aviso usa o molde. */
export function camposDoAvisoAoDono(bruto: unknown): CamposDoAvisoAoDono | null {
  const o = typeof bruto === "string" ? { texto: bruto } : objeto(bruto);
  if (o === null) return null;
  const texto = sanitizarTextoDoLead(typeof o.texto === "string" ? o.texto : null, TETOS_DO_TEXTO_DO_LEAD.aviso_ao_dono);
  if (!texto) return null;
  const acao =
    typeof o.acao_proposta === "string" && (ACOES_DO_AVISO_AO_DONO as readonly string[]).includes(o.acao_proposta)
      ? (o.acao_proposta as AcaoDoAvisoAoDono)
      : null;
  const comp = compromisso(o.compromisso);
  return {
    aviso_ao_dono: texto,
    ...(acao ? { aviso_acao: acao } : {}),
    ...(comp ? { aviso_compromisso: comp } : {}),
  };
}
