/**
 * O JEV NO FORK (fork elllo, 16/11/2026) — a porta (`lib/escalacao/jev-do-fork.ts`)
 * e as três decisões puras: o tom áspero, a propaganda sem forma de disparo e
 * a mensagem de grupo. Mais o texto e o fluxo do apanhado das 7h.
 *
 * Sem rede e sem banco: a chamada ao Jev, o gasto do dia e o registro são
 * dublês; o disjuntor é o de verdade (em memória), com uma organização por
 * teste para um não abrir o do outro.
 */
import { describe, expect, it, vi } from "vitest";

import type { Resposta, ResultadoDaDecisao } from "@/lib/ai/decisao/cliente";
import type { MensagemParaAvaliar } from "@/lib/escalacao/avaliacao-da-passagem";
import {
  aplicaApanhado,
  dentroDaJanelaDoApanhado,
  diasDoApanhado,
  montarApanhado,
  type DepsDoApanhado,
  type ItemParaOApanhado,
} from "@/lib/escalacao/apanhado-do-dono";
import { decidirPeloJev, estadoDoTom, MINIMO_PARA_PROPAGANDA } from "@/lib/escalacao/avaliacao-pelo-jev";
import { estadoDoGrupo, textoDoGrupo, valeResponder } from "@/lib/escalacao/grupos-pelo-jev";
import {
  lerJevDoFork,
  perguntarAoJevDoFork,
  PROPOSITOS_DO_JEV_DO_FORK,
  type DepsDoJevDoFork,
  type LinhaDoJevDoFork,
  type ResultadoDoJevDoFork,
} from "@/lib/escalacao/jev-do-fork";
import { decidirPropaganda, textoParaPerguntar } from "@/lib/escalacao/propaganda-pelo-jev";

const ECAD =
  "*RASGUE O BOLETO. NÃO O SEU LUCRO!* Sua academia ainda paga ECAD para tocar música? 😱 Você sabia que esse custo retira R$ 5 MIL até R$ 25 MIL de lucro em 5 anos?";

function choice(escolha: string, probabilidades: Record<string, number>, confianca = 0.9): Resposta {
  return { tipo: "choice", escolha, probabilidades, confianca };
}
function noul(p: number): Resposta {
  return { tipo: "noul", noul: p };
}
function respondeu(respostas: Record<string, Resposta>): ResultadoDoJevDoFork {
  return { ok: true, respostas, latenciaMs: 300, custoCentavos: 0.001, modelo: "jev-1.13.0" };
}

describe("lerJevDoFork — tudo ligado por padrão; só o booleano false desliga", () => {
  it.each([
    [null, true, 0.5],
    [{}, true, 0.5],
    [{ crm: { jev_do_fork: "torto" } }, true, 0.5],
    [{ crm: { jev_do_fork: { teto_diario_usd: 2 } } }, true, 2],
    [{ crm: { jev_do_fork: { teto_diario_usd: -1 } } }, true, 0.5],
  ])("%j → ligado, teto %s", (settings, ligado, teto) => {
    const c = lerJevDoFork(settings);
    expect([c.avaliacao, c.propaganda, c.grupos, c.apanhado]).toEqual([ligado, ligado, ligado, ligado]);
    expect(c.teto_diario_usd).toBe(teto);
  });

  it("desliga uma parte sem desligar as outras", () => {
    const c = lerJevDoFork({ crm: { jev_do_fork: { grupos: false } } });
    expect(c).toMatchObject({ avaliacao: true, propaganda: true, grupos: false, apanhado: true });
  });
});

function depsDoJev(op: { gasto?: number; resposta?: ResultadoDaDecisao } = {}) {
  const linhas: LinhaDoJevDoFork[] = [];
  const perguntar = vi.fn(
    async (): Promise<ResultadoDaDecisao> =>
      op.resposta ?? {
        ok: true,
        respostas: { propaganda: noul(0.97), cliente: noul(0.03) },
        uso: { tokensDeEntrada: 410, tokensDeSaida: 0 },
        modelo: "jev-1.13.0",
        latenciaMs: 420,
      },
  );
  const deps: DepsDoJevDoFork = {
    gastoEmCentavos: vi.fn(async () => op.gasto ?? 0),
    perguntar,
    custoCentavos: (_m, tokens) => (tokens * 0.042) / 1_000_000 * 100,
    registrar: vi.fn(async (l) => void linhas.push(l)),
    agora: () => new Date("2026-11-16T17:54:00.000Z"),
  };
  return { deps, linhas, perguntar };
}

const PERGUNTA = (org: string) => ({
  organizationId: org,
  contactId: "contato-1",
  proposito: PROPOSITOS_DO_JEV_DO_FORK.propaganda,
  estado: { mensagem_recebida: ECAD },
  perguntas: { propaganda: { tipo: "noul" as const, instrucao: "é propaganda?" } },
  tetoDiarioUsd: 0.5,
});

describe("perguntarAoJevDoFork — teto do dia, disjuntor e registro", () => {
  it("responde e registra a linha com o custo fracionário", async () => {
    const { deps, linhas } = depsDoJev();
    const r = await perguntarAoJevDoFork(deps, PERGUNTA("org-ok"));
    expect(r.ok).toBe(true);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      purpose: "elllo_jev_propaganda",
      model: "typesafe/jev-1.13.0",
      input_tokens: 410,
      status: "ok",
    });
    expect(linhas[0]!.cost_cents).toBeCloseTo(0.001722, 6);
  });

  it("teto do dia estourado: nada sai para a rede", async () => {
    const { deps, perguntar, linhas } = depsDoJev({ gasto: 50 });
    const r = await perguntarAoJevDoFork(deps, PERGUNTA("org-teto"));
    expect(r).toEqual({ ok: false, motivo: "teto_diario" });
    expect(perguntar).not.toHaveBeenCalled();
    expect(linhas).toHaveLength(0);
  });

  it("sem credencial (Jev desligado na tela): sem linha, sem disjuntor", async () => {
    const { deps, linhas } = depsDoJev({
      resposta: { ok: false, motivo: "sem_credencial", exigeAcao: false, defeitoNosso: false, status: null },
    });
    expect(await perguntarAoJevDoFork(deps, PERGUNTA("org-sem-chave"))).toEqual({ ok: false, motivo: "sem_credencial" });
    expect(linhas).toHaveLength(0);
  });

  it("três quedas seguidas abrem o disjuntor: a quarta nem sai", async () => {
    const { deps, perguntar, linhas } = depsDoJev({
      resposta: {
        ok: false,
        motivo: "provedor_indisponivel",
        exigeAcao: false,
        defeitoNosso: false,
        status: 503,
        latenciaMs: 80,
      },
    });
    for (let i = 0; i < 3; i++) await perguntarAoJevDoFork(deps, PERGUNTA("org-caiu"));
    expect(linhas.map((l) => l.error_code)).toEqual(Array(3).fill("jev_provedor_indisponivel"));
    expect(await perguntarAoJevDoFork(deps, PERGUNTA("org-caiu"))).toEqual({ ok: false, motivo: "disjuntor_aberto" });
    expect(perguntar).toHaveBeenCalledTimes(3);
  });

  it("dependência que lança vira ausência, nunca exceção", async () => {
    const { deps } = depsDoJev();
    deps.gastoEmCentavos = async () => {
      throw new Error("banco caiu");
    };
    expect(await perguntarAoJevDoFork(deps, PERGUNTA("org-erro"))).toEqual({ ok: false, motivo: "erro" });
  });
});

describe("o tom áspero pelo Jev (decidirPeloJev)", () => {
  it("brincadeira com 0,8 e alguma opção cabe: vale o Jev", () => {
    const r = decidirPeloJev(
      respondeu({ hipotese: choice("brincadeira", { brincadeira: 0.8, irritacao_real: 0.1 }), alguma_cabe: noul(0.9) }),
    );
    expect(r).toEqual({
      disponivel: true,
      hipotese: "brincadeira",
      confianca: 0.8,
      indicios: [],
      recomendacao: null,
      contexto: null,
    });
  });

  it("propaganda com 0,93: cala (propaganda: true, hipótese 'outro' para o vocabulário da passagem)", () => {
    const r = decidirPeloJev(
      respondeu({ hipotese: choice("propaganda", { propaganda: 0.93 }), cliente: noul(0.16), alguma_cabe: noul(0.95) }),
    );
    expect(r).toMatchObject({ disponivel: true, propaganda: true, hipotese: "outro", confianca: 0.93 });
  });

  it("propaganda que parece de cliente (cliente > 0,3) ou sem o Noul do cliente: o Jev não decide", () => {
    const base = { hipotese: choice("propaganda", { propaganda: 0.97 }), alguma_cabe: noul(0.9) };
    expect(decidirPeloJev(respondeu({ ...base, cliente: noul(0.35) }))).toBeNull();
    expect(decidirPeloJev(respondeu(base))).toBeNull();
  });

  it("propaganda abaixo de 0,85: o Jev não decide (calar irritação real é o erro caro)", () => {
    const p = MINIMO_PARA_PROPAGANDA - 0.01;
    expect(
      decidirPeloJev(respondeu({ hipotese: choice("propaganda", { propaganda: p }), cliente: noul(0.1), alguma_cabe: noul(0.9) })),
    ).toBeNull();
  });

  it.each([
    ["nenhuma opção cabe", respondeu({ hipotese: choice("brincadeira", { brincadeira: 0.9 }), alguma_cabe: noul(0.3) })],
    ["dúvida (0,5)", respondeu({ hipotese: choice("engano", { engano: 0.5 }), alguma_cabe: noul(0.9) })],
    ["sem o companion", respondeu({ hipotese: choice("engano", { engano: 0.9 }) })],
    ["Jev fora do ar", { ok: false, motivo: "provedor_indisponivel" } as ResultadoDoJevDoFork],
  ])("%s → null (a reserva avalia)", (_nome, r) => {
    expect(decidirPeloJev(r)).toBeNull();
  });

  const MENSAGENS: MensagemParaAvaliar[] = [
    { direction: "outbound", sent_via: "ai", body: "Oi! Posso ajudar?", metadata: null, created_at: "2026-11-16T17:50:00Z" },
    { direction: "inbound", sent_via: null, body: "isso é um absurdo", metadata: null, created_at: "2026-11-16T17:53:00Z" },
  ];

  it("com o aceite de 'cada mensagem', só a mensagem áspera vai ao Jev", () => {
    expect(estadoDoTom(MENSAGENS, "mensagem")).toEqual({
      situacao: expect.any(String),
      mensagem_recebida: "isso é um absurdo",
    });
  });

  it("com o aceite da conversa, vai também a transcrição", () => {
    expect(estadoDoTom(MENSAGENS, "conversa")).toMatchObject({ conversa_recente: expect.stringContaining("IA: Oi!") });
  });
});

describe("a propaganda sem forma de disparo (decidirPropaganda)", () => {
  it("o texto do ECAD vale a pergunta; 'oi, tudo bem?' não", () => {
    expect(textoParaPerguntar(ECAD)).toContain("RASGUE O BOLETO");
    expect(textoParaPerguntar("oi, tudo bem?")).toBeNull();
  });

  it("cala só com propaganda ≥ 0,9 E cliente ≤ 0,2", () => {
    expect(decidirPropaganda(respondeu({ propaganda: noul(0.97), cliente: noul(0.03) }))).toEqual({
      propaganda: true,
      probabilidade: 0.97,
      cliente: 0.03,
    });
    expect(decidirPropaganda(respondeu({ propaganda: noul(0.97), cliente: noul(0.4) }))?.propaganda).toBe(false);
    expect(decidirPropaganda(respondeu({ propaganda: noul(0.85), cliente: noul(0.01) }))?.propaganda).toBe(false);
  });

  it("Jev fora do ar ou resposta incompleta: null (vale o caminho de hoje)", () => {
    expect(decidirPropaganda({ ok: false, motivo: "teto_diario" })).toBeNull();
    expect(decidirPropaganda(respondeu({ propaganda: noul(0.99) }))).toBeNull();
  });
});

describe("a mensagem de grupo (valeResponder)", () => {
  it("'bom dia' não vale a pergunta; uma pergunta ao dono vale", () => {
    expect(textoDoGrupo("Bom dia, grupo!")).toBeNull();
    expect(textoDoGrupo("Lucas, você indica um sistema de grade de aulas?")).not.toBeNull();
  });

  it("o estado leva o NOME de quem escreveu, nunca o telefone", () => {
    expect(estadoDoGrupo({ empresa: "Grade Pronta", grupo: "Academias MS", remetente: "João", mensagem: "oi" })).toEqual({
      empresa: "Grade Pronta",
      grupo: "Academias MS",
      quem_escreveu: "João",
      mensagem: "oi",
    });
  });

  it("devolve a probabilidade, ou null quando o Jev não respondeu", () => {
    expect(valeResponder(respondeu({ vale_responder: noul(0.82) }))).toBe(0.82);
    expect(valeResponder({ ok: false, motivo: "disjuntor_aberto" })).toBeNull();
  });
});

describe("o apanhado das 7h", () => {
  const ITENS: ItemParaOApanhado[] = [
    {
      id: "i1",
      tipo: "propaganda",
      conversationId: "c1",
      criadoEm: "2026-11-15T17:53:57Z",
      texto: ECAD,
      remetente: "Vymber Rádio Indoor",
      grupo: null,
    },
    {
      id: "i2",
      tipo: "grupo",
      conversationId: "c2",
      criadoEm: "2026-11-15T20:00:00Z",
      texto: "Lucas, você indica um sistema de grade de aulas? Liga 67 99999-0000",
      remetente: "João",
      grupo: "Academias MS",
    },
  ];

  it("uma mensagem só: propagandas (contagem e uma linha) e grupos (com o link), texto limpo", () => {
    const texto = montarApanhado({ marca: "Grade Pronta", ontem: "2026-11-15", itens: ITENS, urlPublica: "https://crm.exemplo.com.br" })!;
    expect(texto.split("\n")[0]).toBe("🗞️ Grade Pronta: apanhado de ontem (15/11)");
    expect(texto).toContain("Propagandas silenciadas: 1\n• Vymber Rádio Indoor: \"");
    expect(texto).toContain("Mensagens de grupo que valem resposta: 1\n• Academias MS, João: \"Lucas, você indica");
    expect(texto).toContain("  Abrir: https://crm.exemplo.com.br/app/inbox?id=c2");
    expect(texto).not.toMatch(/99999/);
  });

  it("nada para contar: null (nada sai)", () => {
    expect(montarApanhado({ marca: "X", ontem: "2026-11-15", itens: [], urlPublica: "https://x" })).toBeNull();
  });

  it("a janela é das 7h às 10h no fuso da organização", () => {
    const fuso = "America/Campo_Grande"; // UTC-4
    expect(dentroDaJanelaDoApanhado(new Date("2026-11-16T10:59:00Z"), fuso)).toBe(false); // 6h59
    expect(dentroDaJanelaDoApanhado(new Date("2026-11-16T11:00:00Z"), fuso)).toBe(true); // 7h
    expect(dentroDaJanelaDoApanhado(new Date("2026-11-16T13:59:00Z"), fuso)).toBe(true); // 9h59
    expect(dentroDaJanelaDoApanhado(new Date("2026-11-16T14:00:00Z"), fuso)).toBe(false); // 10h
    expect(diasDoApanhado(new Date("2026-11-16T11:05:00Z"), fuso)).toEqual({
      hoje: "2026-11-16",
      ontem: "2026-11-15",
      meiaNoite: new Date("2026-11-16T04:00:00Z"),
    });
  });

  function depsDoApanhado(op: { itens?: ItemParaOApanhado[]; envia?: boolean; agora?: string } = {}) {
    const soltos: string[][] = [];
    const enviados: string[] = [];
    const deps: DepsDoApanhado = {
      urlPublica: "https://crm.exemplo.com.br",
      clock: () => new Date(op.agora ?? "2026-11-16T11:05:00Z"),
      ligado: async () => true,
      destino: async () => ({ channelSessionId: "canal-1", telefoneDestino: "+5567999990000" }),
      fuso: async () => "America/Campo_Grande",
      marca: async () => "Grade Pronta",
      reivindicar: vi.fn(async () => op.itens ?? ITENS),
      soltar: vi.fn(async (_o, ids) => void soltos.push([...ids])),
      enviar: vi.fn(async (_o, _d, texto) => {
        if (op.envia === false) return { enviado: false, motivo: "canal_desconectado" };
        enviados.push(texto);
        return { enviado: true, motivo: "ok" };
      }),
    };
    return { deps, soltos, enviados };
  }

  it("dentro da janela: reivindica os itens de antes da meia-noite e envia UMA mensagem", async () => {
    const { deps, enviados } = depsDoApanhado();
    expect(await aplicaApanhado(deps, "org-1")).toEqual({ status: "ok", detail: "apanhado:enviado:2" });
    expect(deps.reivindicar).toHaveBeenCalledWith(
      "org-1",
      "2026-11-16",
      new Date("2026-11-13T04:00:00Z"),
      new Date("2026-11-16T04:00:00Z"),
    );
    expect(enviados).toHaveLength(1);
  });

  it("fora da janela: nem reivindica", async () => {
    const { deps } = depsDoApanhado({ agora: "2026-11-16T15:00:00Z" });
    expect((await aplicaApanhado(deps, "org-1")).detail).toBe("apanhado:fora_da_janela");
    expect(deps.reivindicar).not.toHaveBeenCalled();
  });

  it("sem itens: nada sai", async () => {
    const { deps } = depsDoApanhado({ itens: [] });
    expect((await aplicaApanhado(deps, "org-1")).detail).toBe("apanhado:vazio");
    expect(deps.enviar).not.toHaveBeenCalled();
  });

  it("envio que não sai: os itens voltam para a próxima rodada", async () => {
    const { deps, soltos } = depsDoApanhado({ envia: false });
    expect((await aplicaApanhado(deps, "org-1")).detail).toBe("apanhado:nao_saiu:canal_desconectado");
    expect(soltos).toEqual([["i1", "i2"]]);
  });
});
