/**
 * A AVALIAÇÃO DA PASSAGEM (fork elllo) — uma chamada curta que nunca segura o aviso.
 *
 * O que se mede: a transcrição marcada (cliente/IA/equipe/[aviso]) sem a
 * mensagem redigida e com o texto da mídia; o orçamento ANTES da chamada; a
 * linha em `llm_calls` no sucesso e na falha, com o ponto `sentiment_classify`;
 * tudo o que o modelo escreve limpo e cortado; e todo desvio vira
 * "indisponível", nunca exceção.
 */
import { describe, expect, it } from "vitest";

import {
  MENSAGENS_DA_AVALIACAO,
  avaliarPassagem,
  montarTranscricao,
  normalizar,
  promptDaAvaliacao,
  type DepsDaAvaliacao,
  type MensagemParaAvaliar,
} from "@/lib/escalacao/avaliacao-da-passagem";
import { MENSAGEM_REDIGIDA } from "@/lib/lgpd/cascata";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";

function msg(over: Partial<MensagemParaAvaliar> & { created_at: string }): MensagemParaAvaliar {
  return { direction: "inbound", sent_via: null, body: "oi", metadata: null, ...over };
}

const MENSAGENS: MensagemParaAvaliar[] = [
  msg({ created_at: "2026-10-25T10:00:00Z", body: "quero a segunda via" }),
  msg({ created_at: "2026-10-25T10:00:05Z", direction: "outbound", sent_via: "ai", body: "claro!" }),
  msg({ created_at: "2026-10-25T10:01:00Z", body: "isso é um absurdo kkk" }),
];

const RESPOSTA_BOA = {
  hipotese: "brincadeira",
  confianca: 0.8,
  indicios: ["usou kkk", "pediu algo simples"],
  recomendacao: "mandar a segunda via",
  contexto: "segunda via do boleto",
};

function deps(over: Partial<DepsDaAvaliacao> = {}) {
  const registros: Array<Record<string, unknown>> = [];
  const chamadas: Array<{ system: string; prompt: string }> = [];
  const d: DepsDaAvaliacao = {
    async resolverModelo() {
      return { model: {}, modelId: "anthropic/claude-haiku-4-5" };
    },
    async podeGastar() {
      return true;
    },
    async gerar(e) {
      chamadas.push({ system: e.system, prompt: e.prompt });
      return { object: RESPOSTA_BOA, promptTokens: 100, completionTokens: 40 };
    },
    async custo() {
      return 1;
    },
    registrar(l) {
      registros.push(l as unknown as Record<string, unknown>);
    },
    agora: () => 0,
    ...over,
  };
  return { d, registros, chamadas };
}

const ENTRADA = {
  organizationId: ORG,
  conversationId: CONVERSA,
  idioma: "pt-BR" as const,
  motivoCodigo: "low_sentiment" as const,
  mensagens: MENSAGENS,
};

describe("montarTranscricao", () => {
  it("marca quem falou, na ordem do tempo", () => {
    const t = montarTranscricao([
      msg({ created_at: "2026-10-25T10:02:00Z", direction: "outbound", sent_via: "user", body: "sou da equipe" }),
      msg({
        created_at: "2026-10-25T10:01:30Z",
        direction: "outbound",
        sent_via: "ai",
        body: "Já acionei o time.",
        metadata: { aviso_de_escalacao: true },
      }),
      ...MENSAGENS,
    ]);
    expect(t.split("\n")).toEqual([
      "cliente: quero a segunda via",
      "IA: claro!",
      "cliente: isso é um absurdo kkk",
      "[aviso]: Já acionei o time.",
      "equipe: sou da equipe",
    ]);
  });

  it("pula a mensagem redigida pela LGPD e usa o texto da mídia quando o corpo é vazio", () => {
    const t = montarTranscricao([
      msg({ created_at: "2026-10-25T10:00:00Z", body: MENSAGEM_REDIGIDA }),
      msg({ created_at: "2026-10-25T10:00:01Z", body: "", media_derived_text: "áudio: cadê meu pedido" }),
    ]);
    expect(t).toBe("cliente: áudio: cadê meu pedido");
  });

  it(`lê no máximo ${MENSAGENS_DA_AVALIACAO} mensagens, as mais recentes`, () => {
    const muitas = Array.from({ length: 30 }, (_, i) =>
      msg({ created_at: new Date(Date.UTC(2026, 9, 25, 10, i)).toISOString(), body: `m${i}` }),
    );
    const linhas = montarTranscricao(muitas).split("\n");
    expect(linhas).toHaveLength(MENSAGENS_DA_AVALIACAO);
    expect(linhas.at(-1)).toBe("cliente: m29");
  });
});

describe("avaliarPassagem", () => {
  it("sucesso: devolve a hipótese e registra a chamada", async () => {
    const { d, registros, chamadas } = deps();
    const r = await avaliarPassagem(d, ENTRADA);
    expect(r).toMatchObject({ disponivel: true, hipotese: "brincadeira", confianca: 0.8 });
    expect(registros).toHaveLength(1);
    expect(registros[0]).toMatchObject({
      organization_id: ORG,
      conversation_id: CONVERSA,
      prompt_tokens: 100,
      completion_tokens: 40,
      cost_cents: 1,
      finish_reason: null,
    });
    expect(chamadas[0]?.prompt).toContain("Motivo da passagem: O cliente demonstrou irritação na conversa");
    expect(chamadas[0]?.prompt).toContain("cliente: isso é um absurdo kkk");
  });

  it("situação tom_aspero (a tolerância): avalia sem passagem nenhuma, com o prompt da conversa em curso", async () => {
    const { d, chamadas } = deps();
    const r = await avaliarPassagem(d, { ...ENTRADA, situacao: "tom_aspero" });
    expect(r).toMatchObject({ disponivel: true, hipotese: "brincadeira" });
    expect(chamadas[0]?.prompt).toContain("Situação: o tom do cliente ficou áspero");
    expect(chamadas[0]?.prompt).not.toContain("Motivo da passagem");
    expect(chamadas[0]?.system).toContain("O atendimento automático continua conversando com ele");
    expect(chamadas[0]?.system).not.toContain("passou uma conversa");
  });

  it("orçamento estourado: não chama o modelo e fica indisponível", async () => {
    const { d, chamadas, registros } = deps({ podeGastar: async () => false });
    const r = await avaliarPassagem(d, ENTRADA);
    expect(r).toEqual({ disponivel: false, porque: "orcamento_de_ia" });
    expect(chamadas).toHaveLength(0);
    expect(registros).toHaveLength(0);
  });

  it("sem modelo: indisponível", async () => {
    const { d } = deps({ resolverModelo: async () => null });
    expect(await avaliarPassagem(d, ENTRADA)).toEqual({ disponivel: false, porque: "sem_modelo" });
  });

  it("erro do modelo: indisponível, e a falha também vira linha em llm_calls", async () => {
    const { d, registros } = deps({
      gerar: async () => {
        throw new Error("No object generated");
      },
    });
    const r = await avaliarPassagem(d, ENTRADA);
    expect(r).toEqual({ disponivel: false, porque: "erro_do_modelo" });
    expect(registros[0]).toMatchObject({ finish_reason: "error", cost_cents: 0 });
  });

  it("resposta fora do contrato: indisponível", async () => {
    const { d } = deps({
      gerar: async () => ({ object: { hipotese: "raiva" }, promptTokens: 1, completionTokens: 1 }),
    });
    expect(await avaliarPassagem(d, ENTRADA)).toEqual({ disponivel: false, porque: "fora_do_contrato" });
  });

  it("nenhuma exceção escapa, nem do resolvedor", async () => {
    const { d } = deps({
      resolverModelo: async () => {
        throw new Error("boom");
      },
    });
    expect(await avaliarPassagem(d, ENTRADA)).toEqual({ disponivel: false, porque: "erro" });
  });

  it("conversa sem fala nenhuma: nem chama", async () => {
    const { d, chamadas } = deps();
    const r = await avaliarPassagem(d, { ...ENTRADA, mensagens: [] });
    expect(r).toEqual({ disponivel: false, porque: "sem_mensagens" });
    expect(chamadas).toHaveLength(0);
  });
});

describe("normalizar", () => {
  it("corta, limpa e confere o contrato: até 3 indícios ≤140, recomendação ≤200, contexto ≤240", () => {
    const n = normalizar({
      hipotese: "irritacao_real",
      confianca: 0.5,
      indicios: ["a".repeat(300), "liga 31998966398", "c", "d", "e"],
      recomendacao: "b".repeat(500) + " https://mal.example",
      contexto: "c".repeat(700),
    });
    expect(n).not.toBeNull();
    expect(n!.indicios).toHaveLength(3);
    expect([...n!.indicios[0]!].length).toBe(140);
    expect(n!.indicios.join(" ")).not.toContain("998966398");
    expect([...n!.recomendacao!].length).toBeLessThanOrEqual(200);
    expect(n!.recomendacao).not.toContain("mal.example");
    expect([...n!.contexto!].length).toBeLessThanOrEqual(240);
  });

  it("texto que não sobrevive à limpeza vira null", () => {
    const n = normalizar({ ...RESPOSTA_BOA, recomendacao: "https://x.example", contexto: "   " });
    expect(n).toMatchObject({ recomendacao: null, contexto: null });
  });
});

describe("promptDaAvaliacao", () => {
  it("pede o idioma da organização e proíbe copiar dado pessoal", () => {
    expect(promptDaAvaliacao("es")).toContain("Español");
    expect(promptDaAvaliacao("pt-BR")).toMatch(/não copie dados pessoais/);
    for (const h of ["brincadeira", "irritacao_real", "engano", "outro"]) {
      expect(promptDaAvaliacao("pt-BR")).toContain(`"${h}"`);
    }
  });
});
