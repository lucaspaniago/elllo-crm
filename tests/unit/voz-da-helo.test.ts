import { describe, expect, it } from "vitest";
import { decisaoAutoriza, ensinoDePromessaSemCaso, SAIDA_DE_HORARIO_NA_VOZ_DA_HELO } from "@/lib/agent-engine/guardrails/voz-da-helo";
import { avaliarHorarios } from "@/lib/agent-engine/guardrails/horario-da-agenda";
import { casePromiseGate, semanticPromiseGate, type GateContext } from "@/lib/agent-engine/guardrails/before-send";

const DECISAO = "Confirme à ADEPOL que Lucas estará presente para a moldagem da placa em 04/12 às 9h40 e agradeça.";

describe("a decisão do dono como autorização, na volta do caso (voz2)", () => {
  it("o caso real da consulta: repetir a data que ele confirmou passa", () => {
    expect(decisaoAutoriza("o Lucas confirmou presença na moldagem da placa dia 04/12 às 9h40", DECISAO)).toBe(true);
  });
  it("outra data, ou uma hora a mais, não passa", () => {
    expect(decisaoAutoriza("o Lucas confirmou a moldagem da placa dia 05/12 às 9h40", DECISAO)).toBe(false);
    expect(decisaoAutoriza("ele vai à moldagem da placa 04/12 às 9h40 e volta dia 11", DECISAO)).toBe(false);
  });
  it("compra e pagamento: NUNCA, mesmo que o dono tenha dito", () => {
    const d = "Diga que eu vou comprar o livro e pago no Pix amanhã.";
    expect(decisaoAutoriza("o Lucas vai comprar o livro e paga no Pix amanhã", d)).toBe(false);
    expect(decisaoAutoriza("ele fecha o valor com vocês", "Diga que ele fecha o valor com vocês")).toBe(false);
  });
  it("promessa que não está na decisão não passa", () => {
    expect(decisaoAutoriza("garanto que ele chega antes do horário", DECISAO)).toBe(false);
    expect(decisaoAutoriza("", DECISAO)).toBe(false);
    expect(decisaoAutoriza("confirmou a moldagem", "")).toBe(false);
  });
});

const base = (o: Partial<GateContext>): GateContext => ({ now: new Date("2026-11-26T11:00:00Z"), body: "", ...o }) as GateContext;
const prometeu = (frase: string) => ({ isPromise: true, suspectPhrase: frase, prometeuRetornoHumano: false, retornoSoDoAssistente: false }) as never;

describe("as travas com a voz da Helô (voz2)", () => {
  it("semantic_promise: sem decisão do dono, veta como sempre; com ela, a repetição passa", () => {
    const frase = "o Lucas confirmou presença na moldagem da placa dia 04/12 às 9h40";
    expect(semanticPromiseGate.evaluate(base({ body: frase, semanticPromise: prometeu(frase) })).pass).toBe(false);
    expect(semanticPromiseGate.evaluate(base({ body: frase, semanticPromise: prometeu(frase), decisaoDoDono: DECISAO })).pass).toBe(true);
    const compra = "ele vai comprar e paga no Pix";
    expect(semanticPromiseGate.evaluate(base({ body: compra, semanticPromise: prometeu(compra), decisaoDoDono: "diga que eu vou comprar e pago no Pix" })).pass).toBe(false);
  });
  it("case_promise: o veto continua; só o ensino muda, sem bastidor", () => {
    const ctx = base({ body: "Vou ver com o Lucas e te falo amanhã", casesEnabled: true, hasOpenCase: false, openedCaseThisTurn: false,
      semanticPromise: { isPromise: false, suspectPhrase: null, prometeuRetornoHumano: true, retornoSoDoAssistente: false } as never,
      followup: { disponivel: true, agendadoNesteTurno: false } });
    const antes = casePromiseGate.evaluate(ctx);
    const depois = casePromiseGate.evaluate({ ...ctx, vozDaHelo: true });
    expect(antes.pass).toBe(false);
    expect(depois.pass).toBe(false);
    if (depois.pass || antes.pass) return;
    expect(depois.code).toBe(antes.code);
    expect(depois.reason).toMatch(/schedule_followup/);
    expect(depois.reason).toMatch(/não conte que anotou/);
    expect(ensinoDePromessaSemCaso(false)).not.toMatch(/schedule_followup/);
  });
  it("horario_da_agenda: a data da decisão conta como do contato; outra data segue vetada", () => {
    const h = { ativo: true, fuso: "America/Campo_Grande", livres: [], doContato: ["2026-12-04T13:40:00.000Z"], marcouNesteTurno: false, vetosAnteriores: 0 };
    const agora = new Date("2026-11-26T11:00:00Z");
    expect(avaliarHorarios("O Lucas confirmou: dia 04/12 às 9h40 ele vai.", agora, h).pass).toBe(true);
    expect(avaliarHorarios("O Lucas confirmou: dia 05/12 às 9h40 ele vai.", agora, h).pass).toBe(false);
    const v = avaliarHorarios("dia 05/12 às 9h40", agora, { ...h, vetosAnteriores: 2, saidaNaVozDaHelo: true });
    expect(v.pass ? "" : v.reason).toBe(SAIDA_DE_HORARIO_NA_VOZ_DA_HELO);
    expect(SAIDA_DE_HORARIO_NA_VOZ_DA_HELO).not.toMatch(/por aqui|equipe/);
  });
});
