import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

// ingest.ts importa @/lib/audit (→ supabase/server → validação de env).
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
// Os efeitos pós-entrada (opt-out, card, despacho da IA) são o que o silêncio
// pula: aqui só importa SE foram chamados, e com qual texto.
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn(async () => undefined) }));
vi.mock("@/lib/leads/encerramento", () => ({ encerraDemanda: vi.fn(async () => ({ lead: {}, jaEstava: false })) }));

import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import { encerraDemanda } from "@/lib/leads/encerramento";
import { dispatchWahaEvent, type WahaEnvelope, type WahaPayload } from "@/lib/waha/ingest";

/**
 * Fork elllo — o disparo automático pelo webhook inteiro, com um banco em
 * memória: o caso real de 07/11/2026 (modelo de marketing com imagem, corpo
 * vazio) entra legível e, com o botão ligado e sem envio nosso anterior, NÃO
 * chega aos efeitos — sem card, sem `ai_agent.dispatch_requested`.
 */

const REAL = JSON.parse(
  readFileSync("lib/waha/__fixtures__/disparo-template-noweb-2026.7.2.json", "utf8"),
) as WahaPayload;

type Linha = Record<string, unknown>;

function banco(inicial: { settings?: unknown; mensagens?: Linha[]; leads?: Linha[] } = {}) {
  const tabelas: Record<string, Linha[]> = {
    organizations: [{ id: "org-1", settings: inicial.settings ?? {} }],
    contacts: [{ id: "contato-1", organization_id: "org-1", is_personal: false }],
    conversations: [
      { id: "conversa-1", organization_id: "org-1", status: "open", assigned_to_user_id: null, current_demanda_id: "dem-1" },
    ],
    demandas: [{ id: "dem-1", organization_id: "org-1", revision: 3, fechada_em: null }],
    crm_leads: inicial.leads ?? [],
    messages: [...(inicial.mensagens ?? [])],
  };
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];

  const consulta = (nome: string) => {
    const iguais: Array<[string, unknown]> = [];
    const diferentes: Array<[string, unknown]> = [];
    const casam = () =>
      (tabelas[nome] ?? []).filter(
        (l) => iguais.every(([c, v]) => (l[c] ?? null) === v) && diferentes.every(([c, v]) => l[c] !== v),
      );
    const q = {
      eq(c: string, v: unknown) {
        iguais.push([c, v]);
        return q;
      },
      neq(c: string, v: unknown) {
        diferentes.push([c, v]);
        return q;
      },
      is(c: string, v: unknown) {
        iguais.push([c, v]);
        return q;
      },
      in: () => q,
      like: () => q,
      gte: () => q,
      order: () => q,
      limit: () => q,
      then(ok: (v: unknown) => unknown) {
        return Promise.resolve(ok({ data: casam(), error: null }));
      },
      async maybeSingle() {
        return { data: casam()[0] ?? null, error: null };
      },
    };
    return q;
  };

  const encadeavel = (): unknown => {
    const e: Record<string, unknown> = { error: null };
    e.eq = () => e;
    e.in = () => e;
    e.select = () => e;
    e.then = (ok: (v: unknown) => unknown) => Promise.resolve(ok({ data: null, error: null }));
    return e;
  };

  const admin = {
    from: (nome: string) => ({
      select: () => consulta(nome),
      insert: (linha: Linha) => ({
        select: () => ({
          async maybeSingle() {
            const nova = { id: `${nome}-${(tabelas[nome] ??= []).length + 1}`, ...linha };
            tabelas[nome].push(nova);
            return { data: { id: nova.id }, error: null };
          },
        }),
      }),
      update: () => encadeavel(),
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      if (fn === "fn_upsert_wa_contact") return { data: "contato-1", error: null };
      if (fn === "fn_upsert_wa_conversation") return { data: "conversa-1", error: null };
      if (fn === "fn_contato_adicionar_etiquetas") {
        return { data: { tags: args.p_etiquetas, adicionadas: args.p_etiquetas }, error: null };
      }
      return { data: null, error: null };
    },
  };
  return { admin, tabelas, rpcs };
}

const SESSION = { id: "sessao-1", organization_id: "org-1" };
const envelope = (payload: WahaPayload): WahaEnvelope => ({ event: "message.any", session: "default", payload });

async function receber(b: ReturnType<typeof banco>, payload: WahaPayload = REAL) {
  await dispatchWahaEvent(b.admin as never, SESSION as never, envelope(payload), "req-1");
  return (b.tabelas.messages ?? []).find((m) => m.direction === "inbound");
}

const efeitos = vi.mocked(aplicarEfeitosPosEntrada);
const fechaCard = vi.mocked(encerraDemanda);

beforeEach(() => {
  efeitos.mockClear();
  fechaCard.mockClear();
});

describe("o disparo automático no webhook", () => {
  it("botão ligado (padrão) e nunca escrevemos: grava legível, etiqueta, encerra e NÃO chama os efeitos", async () => {
    const b = banco();
    const linha = await receber(b);

    // O tipo continua sendo o que a ingestão já decidia (no caso real, `image`
    // pelo `media.mimetype`, que o trecho anonimizado não traz).
    expect(String(linha?.body)).toContain("ESQUENTA BLACK FRIDAY");
    expect(String(linha?.body)).toContain("[SIM, CUPOM] [ARQUIVAR]");
    expect((linha?.metadata as Linha).disparo_automatico).toEqual({
      tipo: "template",
      empresa: "Rádio Exemplo Indoor",
    });

    expect(efeitos, "a IA foi acordada para uma propaganda").not.toHaveBeenCalled();
    const fns = b.rpcs.map((r) => r.fn);
    expect(b.rpcs.find((r) => r.fn === "fn_contato_adicionar_etiquetas")?.args.p_etiquetas).toEqual(["propaganda"]);
    expect(b.rpcs.find((r) => r.fn === "emit_event" && r.args.p_event_type === "contact.tag_added")).toBeDefined();
    expect(b.rpcs.find((r) => r.fn === "fn_service_status")?.args).toMatchObject({ p_status: "closed" });
    expect(b.rpcs.find((r) => r.fn === "fn_demanda_encerrar")?.args).toMatchObject({
      p_demanda: "dem-1",
      p_expected: 3,
      p_desfecho: "nao_procede",
    });
    expect(fns).not.toContain("fn_conversation_assign"); // sem atendente, nada a soltar
    expect(b.rpcs.some((r) => r.args.p_event_type === "ai_agent.dispatch_requested")).toBe(false);
  });

  it("card aberto que o contato já tinha vai para o perdido (motivo other)", async () => {
    const b = banco({ leads: [{ id: "lead-1", organization_id: "org-1", contact_id: "contato-1", status: "open" }] });
    await receber(b);
    expect(fechaCard).toHaveBeenCalledTimes(1);
    expect(fechaCard.mock.calls[0]?.[2]).toMatchObject({ leadId: "lead-1", desfecho: "lost", motivo: "other" });
  });

  it("botão desligado: tudo como hoje — os efeitos rodam com o texto de sempre (null), mas a mensagem fica legível", async () => {
    const b = banco({ settings: { crm: { silenciar_disparos_automaticos: false } } });
    const linha = await receber(b);
    expect(String(linha?.body)).toContain("ESQUENTA BLACK FRIDAY");
    expect((linha?.metadata as Linha).disparo_automatico).toBeDefined();
    expect(efeitos).toHaveBeenCalledTimes(1);
    expect(efeitos.mock.calls[0]?.[1]).toMatchObject({ contactId: "contato-1", texto: null });
    expect(b.rpcs.map((r) => r.fn)).not.toContain("fn_contato_adicionar_etiquetas");
    expect(b.rpcs.map((r) => r.fn)).not.toContain("fn_service_status");
  });

  it("nós escrevemos primeiro (prospect respondendo por robô): tudo como hoje", async () => {
    const b = banco({
      mensagens: [{ id: "out-1", organization_id: "org-1", contact_id: "contato-1", direction: "outbound", status: "read" }],
    });
    await receber(b);
    expect(efeitos).toHaveBeenCalledTimes(1);
    expect(b.rpcs.map((r) => r.fn)).not.toContain("fn_contato_adicionar_etiquetas");
  });

  it("envio nosso que FALHOU não conta como 'escrevemos': silencia", async () => {
    const b = banco({
      mensagens: [{ id: "out-1", organization_id: "org-1", contact_id: "contato-1", direction: "outbound", status: "failed" }],
    });
    await receber(b);
    expect(efeitos).not.toHaveBeenCalled();
  });

  it("mensagem de gente: nada muda (sem marca, efeitos chamados)", async () => {
    const b = banco();
    const linha = await receber(b, {
      id: "false_5511900000002@c.us_3EB0000000000000000001",
      from: "5511900000002@c.us",
      fromMe: false,
      body: "oi, quanto custa?",
      timestamp: 1_762_520_000,
      _data: { message: { conversation: "oi, quanto custa?" } },
    });
    expect(linha?.body).toBe("oi, quanto custa?");
    expect((linha?.metadata as Linha).disparo_automatico).toBeUndefined();
    expect(efeitos).toHaveBeenCalledTimes(1);
    expect(efeitos.mock.calls[0]?.[1]).toMatchObject({ texto: "oi, quanto custa?" });
  });

  it("modelo SÓ de texto, sem body nem mídia, não é mais descartado", async () => {
    const b = banco();
    const linha = await receber(b, {
      id: "false_5511900000003@c.us_3EB0000000000000000002",
      from: "5511900000003@c.us",
      fromMe: false,
      body: null,
      timestamp: 1_762_520_000,
      _data: {
        message: { templateMessage: { hydratedTemplate: { hydratedContentText: "Seu boleto vence amanhã" } } },
      },
    });
    expect(linha?.body).toBe("Seu boleto vence amanhã");
    expect(efeitos).not.toHaveBeenCalled();
  });
});
