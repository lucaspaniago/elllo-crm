import { z } from "zod";

import { CATEGORIAS_DO_DOSSIE, type CategoriaDoDossie, type FonteDoDossie } from "@/lib/agent-engine/agent/dossie";

/**
 * O dossiê do contato pela TELA (fork elllo, migration 9005) — as regras puras das
 * rotas `app/api/v1/contacts/[id]/dossie`. Sem I/O: testável sem banco.
 *
 * - O que a tela ESCREVE é sempre fonte `lucas` (quem está na tela é a empresa).
 * - Corrigir mantém a fonte da linha: o dono conserta o que a pessoa disse sem que a
 *   linha passe a "contada por ele". A exceção é a observação da Helô (`helo`, só
 *   jeito/tom) mudada para outra categoria: aí ela deixa de ser observação de jeito e
 *   passa a ser do dono.
 * - `liberada` ("pode usar com ele") só existe para fonte `lucas` (CHECK da 9005).
 */

export const TITULO_MAX = 300;
export const TEXTO_MAX = 4_000;

export const criarNotaSchema = z.strictObject({
  headline: z.string().trim().min(1).max(TITULO_MAX),
  body: z.string().trim().min(1).max(TEXTO_MAX),
  categoria: z.enum(CATEGORIAS_DO_DOSSIE),
  liberada: z.boolean().optional(),
});

export const corrigirNotaSchema = z
  .strictObject({
    headline: z.string().trim().min(1).max(TITULO_MAX).optional(),
    body: z.string().trim().min(1).max(TEXTO_MAX).optional(),
    categoria: z.enum(CATEGORIAS_DO_DOSSIE).optional(),
    liberada: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "nada para corrigir" });

export type CorrecaoDaNota = z.infer<typeof corrigirNotaSchema>;

export interface NotaAtual {
  categoria: CategoriaDoDossie;
  fonte: FonteDoDossie;
  liberada: boolean;
}

/**
 * A linha depois da correção, ou o motivo da recusa. `embedding: null` sempre que o
 * texto muda: o vetor do recall é derivado do texto e deixaria de bater.
 */
export function aplicarCorrecao(
  atual: NotaAtual,
  c: CorrecaoDaNota,
):
  | { ok: true; valores: Record<string, unknown> }
  | { ok: false; motivo: "liberada_so_do_lucas" } {
  const categoria = c.categoria ?? atual.categoria;
  let fonte: FonteDoDossie = atual.fonte;
  if (fonte === "helo" && categoria !== "jeito" && categoria !== "tom") fonte = "lucas";
  const liberada = c.liberada ?? (fonte === "lucas" ? atual.liberada : false);
  if (liberada && fonte !== "lucas") return { ok: false, motivo: "liberada_so_do_lucas" };
  const valores: Record<string, unknown> = { categoria, fonte, liberada, updated_at: new Date().toISOString() };
  if (c.headline !== undefined) valores.headline = c.headline;
  if (c.body !== undefined) valores.body = c.body;
  if (c.headline !== undefined || c.body !== undefined) valores.embedding = null;
  return { ok: true, valores };
}
