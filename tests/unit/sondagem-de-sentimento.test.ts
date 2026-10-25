/**
 * A SONDAGEM ANTES DA PASSAGEM POR SENTIMENTO (fork elllo).
 *
 * Uma pergunta discreta entre o alerta de clima e a passagem. O que se mede,
 * sobre dublês de banco, envio e orquestrador:
 *
 *   - as guardas de início — e que cada uma devolve `null` (a passagem de
 *     sempre), nunca um silêncio;
 *   - o CAS: quem perde a chave pula; chave de outro evento pula, a menos que
 *     esteja abandonada;
 *   - o envio idempotente (a mensagem com este `evento_id`, a janela de 2 min);
 *   - a espera nunca dorme: `retry` em min(prazo, agora + 60 s);
 *   - a conclusão: com resposta avisa o cliente, sem resposta não; o silêncio da
 *     sondagem é repassado ao gate; a chave sai;
 *   - envio recusado: limpa, devolve o silêncio e passa na hora;
 *   - qualquer erro: sem sondagem — e, se a chave deste evento já existe, a
 *     passagem sai com o silêncio dela ignorado.
 */
import { describe, expect, it } from "vitest";

import type { TriggerHandoffInput } from "@/lib/ai/handoff/orchestrator";
import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
import {
  CHAVE_DA_SONDAGEM,
  FOLGA_DA_CHAVE_VENCIDA_MS,
  JANELA_DO_ENVIO_MS,
  PASSO_DA_ESPERA_MS,
  PERGUNTAS_DE_RESERVA,
  aplicaSondagem,
  perguntaDeReserva,
  promptDaPergunta,
  type ChaveDaSondagem,
  type ConversaDaSondagem,
  type MensagemDaSondagem,
  type SondagemDeps,
} from "@/lib/escalacao/sondagem-de-sentimento";
import type { EventRow } from "@/lib/event-log/dispatcher";

const AGORA = new Date("2026-10-25T14:00:00.000Z");
const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const EVENTO = "44444444-4444-4444-8444-444444444444";

const BOUNDARY: ServiceBoundary = {
  organization_id: ORG,
  contact_id: CONTATO,
  conversation_id: CONVERSA,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

const ROW: EventRow = {
  id: EVENTO,
  organization_id: ORG,
  event_type: "ai.sentiment_alert",
  entity_kind: "message",
  entity_id: "m1",
  payload: { message_id: "m1", conversation_id: CONVERSA },
  metadata: {},
  consumed_by: [],
  attempts: 0,
  created_at: AGORA.toISOString(),
};

const PASSAGEM: TriggerHandoffInput = {
  serviceBoundary: BOUNDARY,
  conversationId: CONVERSA,
  organizationId: ORG,
  reason: "low_sentiment",
  origem: "sentimento",
  leadId: null,
  metadata: { sentiment_score: 0.1 },
};

interface Opcoes {
  minutos?: number | null;
  conversa?: Partial<ConversaDaSondagem>;
  chave?: ChaveDaSondagem | null;
  elegivel?: boolean;
  iaJaFalou?: boolean;
  sondagemRecente?: boolean;
  perdeOCas?: boolean;
  enviada?: MensagemDaSondagem | null;
  enviaOk?: boolean;
  resposta?: boolean;
  humanoFalou?: boolean;
  agora?: Date;
  redigido?: string | null;
  fronteira?: ServiceBoundary | null;
  quebraEm?: "minutos";
}

function monta(op: Opcoes = {}) {
  const chamadas: TriggerHandoffInput[] = [];
  const enviadas: Array<{ body: string; eventoId: string }> = [];
  const limpezas: Array<{ chave: ChaveDaSondagem; devolver: boolean }> = [];
  let chave: ChaveDaSondagem | null = op.chave ?? null;
  const deps: SondagemDeps = {
    clock: () => op.agora ?? AGORA,
    async elegivel() {
      return op.elegivel ?? true;
    },
    async redigir() {
      return op.redigido === undefined ? "Oi! Tudo certo por aí? Posso te ajudar com algo?" : op.redigido;
    },
    async enviar(e) {
      enviadas.push({ body: e.body, eventoId: e.eventoId });
      return op.enviaOk ?? true;
    },
    async fronteiraAtual() {
      return op.fronteira === undefined ? BOUNDARY : op.fronteira;
    },
    async passar(input) {
      chamadas.push(input);
      return { triggered: true, reason: input.reason };
    },
    db: {
      async minutosDaSondagem() {
        if (op.quebraEm === "minutos") throw new Error("coluna sondagem_minutos não existe");
        return op.minutos === undefined ? 10 : op.minutos;
      },
      async carregaConversa() {
        return {
          metadata: chave ? { [CHAVE_DA_SONDAGEM]: chave } : {},
          bot_silenced_until: chave?.prazo_em ?? null,
          is_group: false,
          assignee_kind: "ai",
          contato: { is_personal: false, is_blocked: false, is_anonymized: false },
          ...(op.conversa ?? {}),
        };
      },
      async iaJaFalou() {
        return op.iaJaFalou ?? true;
      },
      async sondagemDesde() {
        return op.sondagemRecente ?? false;
      },
      async marca(_o, _c, nova) {
        if (op.perdeOCas) return false;
        chave = nova;
        return true;
      },
      async limpa(_o, _c, c, devolver) {
        limpezas.push({ chave: c, devolver });
        if (chave?.evento_id === c.evento_id) chave = null;
      },
      async mensagemDaSondagem() {
        return op.enviada ?? null;
      },
      async respostaDepois() {
        return op.resposta ? { id: "r1" } : null;
      },
      async humanoFalouDepois() {
        return op.humanoFalou ?? false;
      },
      async inboundMaisRecente() {
        return "m2";
      },
      async ultimasMensagens() {
        return [];
      },
      async idioma() {
        return "pt-BR" as const;
      },
    },
  };
  const ctx = { row: ROW, boundary: BOUNDARY, conversationId: CONVERSA, contactId: CONTATO, passagem: PASSAGEM };
  return { deps, ctx, chamadas, enviadas, limpezas, chave: () => chave };
}

const CHAVE: ChaveDaSondagem = {
  evento_id: EVENTO,
  iniciada_em: new Date(AGORA.getTime() - 5 * 60_000).toISOString(),
  prazo_em: new Date(AGORA.getTime() + 5 * 60_000).toISOString(),
};
const ENVIADA: MensagemDaSondagem = {
  id: "s1",
  created_at: new Date(AGORA.getTime() - 5 * 60_000).toISOString(),
  status: "sent",
};

describe("sondagem — as guardas de início devolvem null (a passagem de sempre)", () => {
  it.each([
    ["sem configuração", { minutos: null }],
    ["sondagem_minutos = 0", { minutos: 0 }],
    ["contato pessoal", { conversa: { contato: { is_personal: true, is_blocked: false, is_anonymized: false } } }],
    ["contato bloqueado", { conversa: { contato: { is_personal: false, is_blocked: true, is_anonymized: false } } }],
    ["contato anonimizado", { conversa: { contato: { is_personal: false, is_blocked: false, is_anonymized: true } } }],
    ["grupo", { conversa: { is_group: true } }],
    ["não elegível", { elegivel: false }],
    ["a IA nunca falou", { iaJaFalou: false }],
    ["sondagem nas últimas 24 h", { sondagemRecente: true }],
    ["erro de leitura", { quebraEm: "minutos" as const }],
  ] as const)("%s", async (_nome, op) => {
    const m = monta(op as Opcoes);
    expect(await aplicaSondagem(m.deps, m.ctx)).toBeNull();
    expect(m.enviadas).toHaveLength(0);
    expect(m.chave()).toBeNull();
  });

  it("sem contato: null", async () => {
    const m = monta();
    expect(await aplicaSondagem(m.deps, { ...m.ctx, contactId: null })).toBeNull();
  });
});

describe("sondagem — início", () => {
  it("marca a chave com o prazo, manda a pergunta e volta em 60 s", async () => {
    const m = monta();
    const r = await aplicaSondagem(m.deps, m.ctx);
    expect(r).toMatchObject({ status: "retry", detail: "sondagem enviada" });
    expect(r?.retry_at).toBe(new Date(AGORA.getTime() + PASSO_DA_ESPERA_MS).toISOString());
    expect(m.chave()).toEqual({
      evento_id: EVENTO,
      iniciada_em: AGORA.toISOString(),
      prazo_em: new Date(AGORA.getTime() + 10 * 60_000).toISOString(),
    });
    expect(m.enviadas).toEqual([{ body: "Oi! Tudo certo por aí? Posso te ajudar com algo?", eventoId: EVENTO }]);
    expect(m.chamadas).toHaveLength(0);
  });

  it("perdeu o CAS: skipped sondagem_em_curso, sem envio", async () => {
    const m = monta({ perdeOCas: true });
    expect(await aplicaSondagem(m.deps, m.ctx)).toEqual({ status: "skipped", detail: "sondagem_em_curso" });
    expect(m.enviadas).toHaveLength(0);
  });

  it("chave de OUTRO evento em curso: skipped, nada muda", async () => {
    const m = monta({ chave: { ...CHAVE, evento_id: "outro" } });
    expect(await aplicaSondagem(m.deps, m.ctx)).toEqual({ status: "skipped", detail: "sondagem_em_curso" });
    expect(m.limpezas).toHaveLength(0);
  });

  it("chave de outro evento ABANDONADA (prazo + 30 min): limpa e começa a desta", async () => {
    const velha = {
      evento_id: "outro",
      iniciada_em: new Date(AGORA.getTime() - 60 * 60_000).toISOString(),
      prazo_em: new Date(AGORA.getTime() - FOLGA_DA_CHAVE_VENCIDA_MS - 60_000).toISOString(),
    };
    const m = monta({ chave: velha });
    const r = await aplicaSondagem(m.deps, m.ctx);
    expect(m.limpezas[0]).toEqual({ chave: velha, devolver: true });
    expect(r?.status).toBe("retry");
    expect(m.chave()?.evento_id).toBe(EVENTO);
  });

  it("o modelo não escreveu (ou escreveu só lixo): a frase de reserva, a mesma para a mesma pessoa", async () => {
    const m = monta({ redigido: "https://so-link.example" });
    await aplicaSondagem(m.deps, m.ctx);
    expect(m.enviadas[0]?.body).toBe(perguntaDeReserva(CONTATO, "pt-BR"));
    expect(Object.values(PERGUNTAS_DE_RESERVA)).toContain(m.enviadas[0]?.body);
  });

  it("envio recusado: limpa, devolve o silêncio e passa NA HORA, avisando o cliente", async () => {
    const m = monta({ enviaOk: false });
    const r = await aplicaSondagem(m.deps, m.ctx);
    expect(r).toEqual({ status: "ok", detail: "low_sentiment" });
    expect(m.limpezas.at(-1)?.devolver).toBe(true);
    expect(m.chamadas[0]?.sondagem).toMatchObject({ avisarLead: true });
    expect(m.chamadas[0]?.sondagem?.silencioAte).toBe(new Date(AGORA.getTime() + 10 * 60_000).toISOString());
  });
});

describe("sondagem — idempotência do envio", () => {
  it("chave deste evento sem mensagem e recente (< 2 min): espera o outro processo", async () => {
    const chave = { ...CHAVE, iniciada_em: new Date(AGORA.getTime() - 30_000).toISOString() };
    const m = monta({ chave });
    const r = await aplicaSondagem(m.deps, m.ctx);
    expect(r?.status).toBe("retry");
    expect(r?.retry_at).toBe(new Date(Date.parse(chave.iniciada_em) + JANELA_DO_ENVIO_MS).toISOString());
    expect(m.enviadas).toHaveLength(0);
  });

  it("chave deste evento sem mensagem e antiga: o processo morreu entre o CAS e o envio — envia", async () => {
    const m = monta({ chave: CHAVE });
    await aplicaSondagem(m.deps, m.ctx);
    expect(m.enviadas).toHaveLength(1);
  });

  it("mensagem deste evento já existe: não envia de novo", async () => {
    const m = monta({ chave: CHAVE, enviada: ENVIADA });
    const r = await aplicaSondagem(m.deps, m.ctx);
    expect(r).toMatchObject({ status: "retry", detail: "aguardando resposta da sondagem" });
    expect(m.enviadas).toHaveLength(0);
  });
});

describe("sondagem — a espera e a conclusão", () => {
  it("a volta é em min(prazo, agora + 60 s)", async () => {
    const pertoDoPrazo = { ...CHAVE, prazo_em: new Date(AGORA.getTime() + 20_000).toISOString() };
    const m = monta({ chave: pertoDoPrazo, enviada: ENVIADA });
    const r = await aplicaSondagem(m.deps, m.ctx);
    expect(r?.retry_at).toBe(pertoDoPrazo.prazo_em);
  });

  it("humano assumiu: limpa a chave e pula", async () => {
    const m = monta({ chave: CHAVE, enviada: ENVIADA, humanoFalou: true });
    expect(await aplicaSondagem(m.deps, m.ctx)).toEqual({ status: "skipped", detail: "humano_assumiu" });
    expect(m.chave()).toBeNull();
    expect(m.chamadas).toHaveLength(0);
  });

  it("o cliente respondeu: passa avisando o cliente, com o silêncio repassado e a chave limpa", async () => {
    const m = monta({ chave: CHAVE, enviada: ENVIADA, resposta: true });
    const r = await aplicaSondagem(m.deps, m.ctx);
    expect(r).toEqual({ status: "ok", detail: "low_sentiment" });
    const p = m.chamadas[0]!;
    expect(p.sondagem).toEqual({ silencioAte: CHAVE.prazo_em, avisarLead: true });
    expect(p.metadata).toMatchObject({ sentiment_score: 0.1, sondagem: { respondeu: true, minutos: 5 } });
    expect(p.motivoTexto).toMatch(/^Sondagem: /);
    expect(m.chave()).toBeNull();
  });

  it("prazo vencido sem resposta: passa SEM avisar o cliente", async () => {
    const m = monta({
      chave: CHAVE,
      enviada: ENVIADA,
      agora: new Date(Date.parse(CHAVE.prazo_em) + 1000),
    });
    await aplicaSondagem(m.deps, m.ctx);
    const p = m.chamadas[0]!;
    expect(p.sondagem).toEqual({ silencioAte: CHAVE.prazo_em, avisarLead: false });
    expect(p.metadata).toMatchObject({ sondagem: { respondeu: false, minutos: 10 } });
    expect(p.motivoTexto).toBe("Sondagem: sem resposta em 10 min");
  });

  it("fronteira obsoleta na conclusão: limpa, devolve o silêncio e pula", async () => {
    const m = monta({ chave: CHAVE, enviada: ENVIADA, resposta: true, fronteira: null });
    expect(await aplicaSondagem(m.deps, m.ctx)).toEqual({ status: "skipped", detail: "service_boundary_stale" });
    expect(m.limpezas.at(-1)?.devolver).toBe(true);
    expect(m.chamadas).toHaveLength(0);
  });

  it("a pergunta falhou depois (status failed): passa na hora, avisando", async () => {
    const m = monta({ chave: CHAVE, enviada: { ...ENVIADA, status: "failed" } });
    await aplicaSondagem(m.deps, m.ctx);
    expect(m.chamadas[0]?.sondagem).toMatchObject({ avisarLead: true });
  });

  it("erro no meio da espera com a chave deste evento: limpa e passa com o silêncio ignorado", async () => {
    const m = monta({ chave: CHAVE, enviada: ENVIADA });
    m.deps.db.respostaDepois = async () => {
      throw new Error("db caiu");
    };
    const r = await aplicaSondagem(m.deps, m.ctx);
    expect(r?.status).toBe("ok");
    expect(m.chamadas[0]?.sondagem).toEqual({ silencioAte: CHAVE.prazo_em, avisarLead: true });
    expect(m.chave()).toBeNull();
  });
});

describe("sondagem — o texto", () => {
  it("o prompt proíbe acusar, citar o cliente e prometer atendente, no idioma da organização", () => {
    const p = promptDaPergunta("es");
    expect(p).toContain("Español");
    expect(p).toMatch(/não acuse/);
    expect(p).toMatch(/não cite/);
    expect(p).toMatch(/não prometa atendente/);
  });

  it("a frase de reserva é traduzida", () => {
    expect(perguntaDeReserva(CONTATO, "es")).not.toBe(perguntaDeReserva(CONTATO, "pt-BR"));
  });
});
