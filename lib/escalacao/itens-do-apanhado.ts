/**
 * A ESCRITA de `itens_do_apanhado` (fork elllo, migration 9004) — uma porta só
 * para os três que gravam: o silêncio de propaganda, a tolerância ao
 * sentimento (propaganda vista pelo Jev) e o grupo avaliado pelo Jev.
 *
 * Só o ponteiro para a mensagem: o texto é lido na hora do apanhado (ver o
 * cabeçalho da 9004). A mesma mensagem entra uma vez por tipo — o `23505` da
 * `unique (organization_id, message_id, tipo)` é "já estava", não erro.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { OrigemDoItem, TipoDoItem } from "./vocabulario-do-apanhado";

export interface ItemNovoDoApanhado {
  organizationId: string;
  tipo: TipoDoItem;
  origem: OrigemDoItem;
  messageId: string;
  conversationId: string;
  probabilidade: number | null;
}

/** Grava o item. `true` = gravou agora; `false` = já estava. Lança em outro erro. */
export async function registrarItemDoApanhado(admin: SupabaseClient, item: ItemNovoDoApanhado): Promise<boolean> {
  const probabilidade =
    item.probabilidade === null || !Number.isFinite(item.probabilidade)
      ? null
      : Math.min(1, Math.max(0, item.probabilidade));
  const { error } = await admin.from("itens_do_apanhado").insert({
    organization_id: item.organizationId,
    tipo: item.tipo,
    origem: item.origem,
    message_id: item.messageId,
    conversation_id: item.conversationId,
    probabilidade,
  });
  if (!error) return true;
  if ((error as { code?: string }).code === "23505") return false;
  throw new Error(error.message);
}
