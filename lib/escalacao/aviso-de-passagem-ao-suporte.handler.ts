/**
 * Adapter fino que pluga `aplicaAvisoDePassagem` (`./aviso-de-passagem-ao-suporte.ts`)
 * no dispatcher do `event_log` (fork elllo) — o mesmo desenho de
 * `./aviso-ao-suporte.handler.ts`, de quem ele reaproveita o transporte, o
 * pacing e os adapters de canal: um envelope de envio só para os dois avisos.
 *
 * ⚠️ O `status` NUNCA é `error` por estado de mundo — `aplicaAvisoDePassagem`
 * só devolve `ok`, `skipped` e `retry`. O `catch` abaixo existe para defeito de
 * PROGRAMA (coluna errada, client que não subiu).
 *
 * `naOrgParada: "pula"`: organização parada não manda mensagem a ninguém, nem à
 * própria equipe — a mesma régua do aviso de caso.
 */
import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { criarPacingDoCanal } from "@/lib/agent-engine/pacing/ledger-supabase";
import { env } from "@/lib/env";
import { origemDoDreno } from "@/lib/event-log/origem-do-dreno";
import { createAdminClient } from "@/lib/supabase/admin";
import { createSupabaseAvisoDb } from "@/lib/escalacao/aviso-ao-suporte";
import { criarTransporteDoAviso } from "@/lib/escalacao/aviso-ao-suporte.handler";
import {
  aplicaAvisoDePassagem,
  createSupabaseAvisoDePassagemDb,
} from "@/lib/escalacao/aviso-de-passagem-ao-suporte";
import { avaliarPassagem, criarDepsDaAvaliacao } from "@/lib/escalacao/avaliacao-da-passagem";
import { EVENTO_PASSAGEM_REGISTRADA } from "@/lib/escalacao/vocabulario-do-aviso-de-passagem";

export const AVISO_DE_PASSAGEM_HANDLER_KEY = "escalacao-aviso-de-passagem.v1";

export const avisoDePassagemAoSuporteHandler: EventHandler = {
  key: AVISO_DE_PASSAGEM_HANDLER_KEY,
  naOrgParada: "pula",
  events: [EVENTO_PASSAGEM_REGISTRADA],
  async handle(row): Promise<HandlerResult> {
    try {
      const admin = createAdminClient();
      const desfecho = await aplicaAvisoDePassagem(
        {
          db: createSupabaseAvisoDePassagemDb(admin),
          canais: createSupabaseAvisoDb(admin),
          transporte: await criarTransporteDoAviso(admin),
          pacing: await criarPacingDoCanal(admin),
          // A avaliação monta as dependências (gateway, orçamento, log) só se
          // for chamada: a maioria das rodadas termina antes, sem configuração.
          avaliar: async (entrada) => avaliarPassagem(await criarDepsDaAvaliacao(), entrada),
          clock: () => new Date(),
          urlPublica: env.NEXT_PUBLIC_APP_URL,
          origemDoDreno,
        },
        row,
      );
      return {
        consumer_key: AVISO_DE_PASSAGEM_HANDLER_KEY,
        status: desfecho.status,
        ...(desfecho.retry_at ? { retry_at: desfecho.retry_at } : {}),
        detail: desfecho.detail,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { consumer_key: AVISO_DE_PASSAGEM_HANDLER_KEY, status: "error", detail };
    }
  },
};
