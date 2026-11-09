/**
 * O HANDLER DO ALERTA DE CLIMA e a tolerância ao sentimento (fork elllo).
 *
 * A regra mora em `lib/escalacao/tolerancia-ao-sentimento.ts` (testada em
 * `tolerancia-ao-sentimento.test.ts`); aqui se prende só a COSTURA no handler
 * do upstream: com desfecho, o handler devolve o desfecho e NÃO passa; com
 * `null`, passa exatamente como o upstream — e a tolerância recebe o mesmo
 * input de passagem que o upstream usaria.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const c: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) c[m] = () => c;
      c.maybeSingle = async () => ({ data: null, error: null });
      return c;
    },
  }),
}));
vi.mock("@/lib/atendimento/origem-mensagem", () => ({
  serviceFromMessage: vi.fn(async () => ({ conversation_id: "conv-1", contact_id: "contato-1" })),
}));
vi.mock("@/lib/ai/handoff/orchestrator", () => ({
  triggerHandoff: vi.fn(async () => ({ triggered: true, reason: "low_sentiment" })),
}));
vi.mock("@/lib/escalacao/tolerancia-ao-sentimento", () => ({
  aplicaToleranciaDeProducao: vi.fn(),
}));

import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";
import { aplicaToleranciaDeProducao } from "@/lib/escalacao/tolerancia-ao-sentimento";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { aiHandoffFromSentimentHandler } from "@/workers/ai-handoff-from-sentiment.handler";

const ROW = {
  id: "evento-1",
  organization_id: "org-1",
  entity_id: "msg-1",
  payload: { message_id: "msg-1", conversation_id: "conv-1", sentiment_score: -0.9 },
} as unknown as EventRow;

describe("handler do alerta de clima + tolerância", () => {
  beforeEach(() => {
    vi.mocked(triggerHandoff).mockClear();
    vi.mocked(aplicaToleranciaDeProducao).mockReset();
  });

  it("a tolerância segurou: devolve o desfecho dela e NÃO passa", async () => {
    vi.mocked(aplicaToleranciaDeProducao).mockResolvedValue({
      status: "skipped",
      detail: "tolerancia:seguiu_atendendo:nota_enviada",
    });
    const r = await aiHandoffFromSentimentHandler.handle(ROW);
    expect(r).toEqual({
      consumer_key: "ai-handoff-from-sentiment.v1",
      status: "skipped",
      detail: "tolerancia:seguiu_atendendo:nota_enviada",
    });
    expect(triggerHandoff).not.toHaveBeenCalled();
  });

  it("null: a passagem do upstream, com o mesmo input que a tolerância recebeu", async () => {
    vi.mocked(aplicaToleranciaDeProducao).mockResolvedValue(null);
    const r = await aiHandoffFromSentimentHandler.handle(ROW);
    expect(r.status).toBe("ok");
    const ctx = vi.mocked(aplicaToleranciaDeProducao).mock.calls[0]![1];
    expect(ctx).toMatchObject({
      conversationId: "conv-1",
      contactId: "contato-1",
      messageId: "msg-1",
    });
    expect(vi.mocked(triggerHandoff).mock.calls[0]![0]).toEqual(ctx.passagem);
    expect(ctx.passagem).toMatchObject({ reason: "low_sentiment", origem: "sentimento" });
  });
});
