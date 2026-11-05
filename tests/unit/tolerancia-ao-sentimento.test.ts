/**
 * A TOLERÂNCIA AO SENTIMENTO (fork elllo) — a IA segue atendendo, e só a
 * segunda irritação confirmada passa a conversa.
 *
 * Sobre dublês: configuração, conversa com `metadata` em memória e CAS de
 * verdade sobre `versao`; avaliação programável; transporte e pacing que só
 * contam; `passar` no lugar do `triggerHandoff`. O que se mede:
 *
 *   - 1ª irritação: registra, não passa; nota ao dono só em brincadeira/engano,
 *     uma vez;
 *   - 2ª irritação na janela: passa só com irritação real ≥ 0,8 (e apaga a
 *     chave); abaixo disso, ou brincadeira, segue — com no máximo uma nota por
 *     janela;
 *   - janela vencida conta como nenhuma; o mesmo evento repetido não conta duas
 *     vezes nem manda duas notas;
 *   - os caminhos de volta ao upstream (`null`): janela 0, sem configuração,
 *     contato pessoal/bloqueado/anonimizado, grupo, humano, inelegível, erro.
 */
import { describe, expect, it } from "vitest";

import type { ResultadoDaAvaliacao } from "@/lib/escalacao/avaliacao-da-passagem";
import {
  CHAVE_DA_TOLERANCIA,
  aplicaToleranciaAoSentimento,
  lerChave,
  type ContextoDaTolerancia,
  type ConversaDaTolerancia,
  type MensagemDaTolerancia,
  type ToleranciaDeps,
} from "@/lib/escalacao/tolerancia-ao-sentimento";
import type { TriggerHandoffInput } from "@/lib/ai/handoff/orchestrator";
import type { EventRow } from "@/lib/event-log/dispatcher";

const T0 = new Date("2026-10-26T14:00:00.000Z");
const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "44444444-4444-4444-8444-444444444444";
const CONTATO = "55555555-5555-4555-8555-555555555555";
const CANAL = "66666666-6666-4666-8666-666666666666";
const MSG = "99999999-9999-4999-8999-999999999999";
const DESTINO = "+5531998966398";
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

function evento(id: string, quando: Date = T0): EventRow {
  return {
    id,
    organization_id: ORG,
    event_type: "ai.sentiment_alert",
    entity_kind: "message",
    entity_id: MSG,
    payload: { message_id: MSG, conversation_id: CONVERSA, sentiment_score: -0.8 },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: new Date(quando.getTime() - 5_000).toISOString(),
  };
}

const PASSAGEM: TriggerHandoffInput = {
  conversationId: CONVERSA,
  organizationId: ORG,
  reason: "low_sentiment",
  origem: "sentimento",
  leadId: null,
  metadata: { sentiment_score: -0.8, message_id: MSG, source: "ai.sentiment_alert" },
};

function ctx(row: EventRow): ContextoDaTolerancia {
  return { row, conversationId: CONVERSA, contactId: CONTATO, messageId: MSG, passagem: PASSAGEM };
}

const MENSAGENS: MensagemDaTolerancia[] = [
  {
    id: MSG,
    direction: "inbound",
    sent_via: null,
    body: "Oi, idiota",
    metadata: null,
    created_at: T0.toISOString(),
  },
  {
    id: "m-0",
    direction: "outbound",
    sent_via: "user",
    body: "saudades!",
    metadata: null,
    created_at: min(-60).toISOString(),
  },
];

const BRINCADEIRA: ResultadoDaAvaliacao = {
  disponivel: true,
  hipotese: "brincadeira",
  confianca: 0.85,
  indicios: ["tom de piada"],
  recomendacao: null,
  contexto: null,
};
const irritacao = (confianca: number): ResultadoDaAvaliacao => ({
  disponivel: true,
  hipotese: "irritacao_real",
  confianca,
  indicios: [],
  recomendacao: null,
  contexto: null,
});
const INDISPONIVEL: ResultadoDaAvaliacao = { disponivel: false, porque: "orcamento_de_ia" };

interface Opcoes {
  config?: Record<string, unknown> | null;
  conversa?: Partial<ConversaDaTolerancia>;
  elegivel?: boolean;
  origem?: "worker" | "request";
  pacingLivreEm?: Date | null;
  falhaNoEnvio?: boolean;
  /** O CAS perde a próxima escrita (outro processo escreveu antes). */
  perdeCas?: boolean;
}

function monta(op: Opcoes = {}) {
  let agora = T0;
  let metadata: Record<string, unknown> = { outra_chave: "fica" };
  const corpos: string[] = [];
  const passagens: TriggerHandoffInput[] = [];
  const avaliacoes: Array<{ situacao: string }> = [];
  let proximaAvaliacao: ResultadoDaAvaliacao | (() => never) = BRINCADEIRA;
  let perdeCas = op.perdeCas ?? false;
  let pacingLivreEm = op.pacingLivreEm ?? null;

  const deps: ToleranciaDeps = {
    clock: () => agora,
    origemDoDreno: () => op.origem ?? "worker",
    async marca() {
      return { nome: "Acme", idioma: "pt-BR" as const };
    },
    async elegivel() {
      return op.elegivel ?? true;
    },
    async avaliar(entrada) {
      avaliacoes.push({ situacao: entrada.situacao });
      if (typeof proximaAvaliacao === "function") proximaAvaliacao();
      return proximaAvaliacao as ResultadoDaAvaliacao;
    },
    async passar(input) {
      passagens.push(input);
      return { triggered: true, reason: "low_sentiment", avisoAoLead: null } as never;
    },
    db: {
      async carregaConfig() {
        if (op.config === null) return null;
        return {
          organization_id: ORG,
          channel_session_id: CANAL,
          telefone_destino: DESTINO,
          ligado: true,
          aviso_de_passagem_ligado: true,
          sondagem_minutos: 30,
          ...(op.config ?? {}),
        } as never;
      },
      async carregaConversa() {
        return {
          metadata: structuredClone(metadata),
          is_group: false,
          assignee_kind: "ai",
          assigned_to_user_id: null,
          contato: { is_personal: false, is_blocked: false, is_anonymized: false },
          ...(op.conversa ?? {}),
        };
      },
      async gravaChave(_o, _c, esperada, nova) {
        if (perdeCas) {
          perdeCas = false;
          return false;
        }
        if ((lerChave(metadata)?.versao ?? null) !== esperada) return false;
        const { [CHAVE_DA_TOLERANCIA]: _fora, ...resto } = metadata;
        metadata = nova ? { ...resto, [CHAVE_DA_TOLERANCIA]: structuredClone(nova) } : resto;
        return true;
      },
      async ultimasMensagens() {
        return MENSAGENS;
      },
    },
    async envio() {
      return {
        urlPublica: "https://crm.exemplo.com.br",
        canais: {
          async carregaCanal() {
            return { id: CANAL, status: "WORKING", archived_at: null, aceitaMensagemLivre: true };
          },
          async destinoEhDaPropriaOrganizacao() {
            return false;
          },
          async registraJidDoAviso() {},
          async nomeDoContato() {
            return "Ana Paula Paniago";
          },
        },
        transporte: {
          async configurado() {
            return true;
          },
          async resolveDestino(_o, _c, tel) {
            return `${tel.replace(/\D/g, "")}@c.us`;
          },
          async envia(_o, _c, _to, body) {
            if (op.falhaNoEnvio) throw new Error("recusado");
            corpos.push(body);
            return { externalId: `wamid.${corpos.length}` };
          },
        },
        pacing: {
          async decide() {
            if (pacingLivreEm && agora.getTime() < pacingLivreEm.getTime()) {
              return { liberado: false, motivo: "espacamento", liberaEm: pacingLivreEm };
            }
            return { liberado: true };
          },
          async registraEnvio() {},
        },
      };
    },
  };

  return {
    deps,
    corpos,
    passagens,
    avaliacoes,
    chave: () => lerChave(metadata),
    metadata: () => metadata,
    em(d: Date) {
      agora = d;
    },
    avalia(r: ResultadoDaAvaliacao | (() => never)) {
      proximaAvaliacao = r;
    },
    liberaPacing() {
      pacingLivreEm = null;
    },
  };
}

describe("tolerância — a primeira irritação", () => {
  it("brincadeira: registra, NÃO passa, e manda UMA nota curta ao dono", async () => {
    const m = monta();
    const r = await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    expect(r).toEqual({ status: "skipped", detail: "tolerancia:seguiu_atendendo:nota_enviada" });
    expect(m.passagens).toHaveLength(0);
    expect(m.avaliacoes).toEqual([{ situacao: "tom_aspero" }]);
    expect(m.corpos).toEqual([
      [
        "🔔 Acme: tom áspero, segui atendendo",
        "Cliente: Ana",
        'Mensagem: "Oi, idiota"',
        "Avaliação da IA: provável brincadeira (85%)",
        `Abrir: https://crm.exemplo.com.br/app/inbox?id=${CONVERSA}`,
      ].join("\n"),
    ]);
    expect(m.chave()).toMatchObject({
      evento_id: "e1",
      eventos: ["e1"],
      hipotese: "brincadeira",
      confianca: 0.85,
      nota_evento_id: "e1",
      primeira_em: T0.toISOString(),
    });
    // A outra chave do metadata sobrevive ao merge.
    expect(m.metadata().outra_chave).toBe("fica");
  });

  it("engano também rende a nota", async () => {
    const m = monta();
    m.avalia({ ...BRINCADEIRA, hipotese: "engano", confianca: 0.7 });
    await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    expect(m.corpos[0]).toContain("Avaliação da IA: provável engano (70%)");
  });

  it("irritação real: registra, NÃO passa e NÃO manda nota — a IA segue sondando sozinha", async () => {
    const m = monta();
    m.avalia(irritacao(0.95));
    const r = await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    expect(r).toEqual({ status: "skipped", detail: "tolerancia:seguiu_atendendo:sem_nota" });
    expect(m.passagens).toHaveLength(0);
    expect(m.corpos).toHaveLength(0);
    expect(m.chave()).toMatchObject({ hipotese: "irritacao_real", nota_evento_id: null });
  });

  it("avaliação indisponível: registra sem hipótese, sem nota, sem passar", async () => {
    const m = monta();
    m.avalia(INDISPONIVEL);
    const r = await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    expect(r?.status).toBe("skipped");
    expect(m.passagens).toHaveLength(0);
    expect(m.corpos).toHaveLength(0);
    expect(m.chave()).toMatchObject({ hipotese: null, confianca: null });
  });

  it("aviso desligado: a irritação fica registrada, a nota não sai", async () => {
    const m = monta({ config: { aviso_de_passagem_ligado: false } });
    const r = await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    expect(r).toEqual({ status: "skipped", detail: "tolerancia:seguiu_atendendo:aviso_desligado" });
    expect(m.corpos).toHaveLength(0);
    expect(m.chave()?.eventos).toEqual(["e1"]);
  });
});

describe("tolerância — a segunda irritação na janela", () => {
  it("irritação real 0,85: passa como o upstream e apaga a chave", async () => {
    const m = monta();
    m.avalia(irritacao(0.9));
    await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    m.em(min(10));
    m.avalia(irritacao(0.85));
    const r = await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e2", min(10))));
    expect(r).toEqual({ status: "ok", detail: "low_sentiment" });
    expect(m.passagens).toEqual([PASSAGEM]);
    expect(m.chave()).toBeNull();
    expect(m.metadata()).not.toHaveProperty(CHAVE_DA_TOLERANCIA);
    expect(m.metadata().outra_chave).toBe("fica");
  });

  it("irritação real 0,6: NÃO passa; a irritação é renovada", async () => {
    const m = monta();
    m.avalia(irritacao(0.9));
    await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    m.em(min(10));
    m.avalia(irritacao(0.6));
    const r = await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e2", min(10))));
    expect(r?.status).toBe("skipped");
    expect(m.passagens).toHaveLength(0);
    expect(m.chave()).toMatchObject({
      evento_id: "e2",
      eventos: ["e1", "e2"],
      ultima_em: min(10).toISOString(),
      primeira_em: T0.toISOString(),
      confianca: 0.6,
    });
  });

  it("brincadeira de novo: não passa, e a nota sai no máximo uma vez por janela", async () => {
    const m = monta();
    await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    expect(m.corpos).toHaveLength(1);

    m.em(min(10));
    const r2 = await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e2", min(10))));
    expect(r2).toEqual({ status: "skipped", detail: "tolerancia:seguiu_atendendo:nota_recente" });
    expect(m.passagens).toHaveLength(0);
    expect(m.corpos).toHaveLength(1);

    // A janela conta da ÚLTIMA irritação (10 min): aos 35 min a série segue
    // viva, e a nota de T0 já tem mais de 30 min — pode sair outra.
    m.em(min(35));
    await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e3", min(35))));
    expect(m.passagens).toHaveLength(0);
    expect(m.corpos).toHaveLength(2);
    expect(m.chave()?.eventos).toEqual(["e1", "e2", "e3"]);
  });

  it("avaliação indisponível na segunda: passa (sem como confirmar a brincadeira)", async () => {
    const m = monta();
    await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    m.em(min(5));
    m.avalia(INDISPONIVEL);
    const r = await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e2", min(5))));
    expect(r?.status).toBe("ok");
    expect(m.passagens).toHaveLength(1);
  });
});

describe("tolerância — janela e repetição", () => {
  it("irritação mais velha que a janela é como nenhuma: a nova é a primeira", async () => {
    const m = monta();
    await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    m.em(min(31));
    m.avalia(irritacao(0.99));
    const r = await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e2", min(31))));
    expect(r?.status).toBe("skipped");
    expect(m.passagens).toHaveLength(0);
    expect(m.chave()).toMatchObject({
      eventos: ["e2"],
      primeira_em: min(31).toISOString(),
      nota_evento_id: null,
    });
  });

  it("o MESMO evento repetido não conta duas vezes, não reavalia e não manda outra nota", async () => {
    const m = monta();
    await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    const antes = m.chave();
    const r = await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    expect(r).toEqual({ status: "skipped", detail: "tolerancia:seguiu_atendendo:nota_ja_enviada" });
    expect(m.avaliacoes).toHaveLength(1);
    expect(m.corpos).toHaveLength(1);
    expect(m.passagens).toHaveLength(0);
    expect(m.chave()).toEqual(antes);
  });

  it("a repetição da SEGUNDA irritação (sem passagem) não vira terceira", async () => {
    const m = monta();
    m.avalia(irritacao(0.9));
    await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    m.em(min(5));
    m.avalia(irritacao(0.5));
    await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e2", min(5))));
    m.avalia(irritacao(0.99));
    await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e2", min(5))));
    expect(m.passagens).toHaveLength(0);
    expect(m.avaliacoes).toHaveLength(2);
    expect(m.chave()?.eventos).toEqual(["e1", "e2"]);
  });

  it("a repetição de uma passagem que morreu no meio retoma a passagem", async () => {
    const m = monta();
    m.avalia(irritacao(0.9));
    await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    m.em(min(5));
    // A passagem lança: a chave fica reivindicada pelo e2, e o erro volta ao
    // upstream (que passaria de novo — o orquestrador deduplica).
    const passarDeVerdade = m.deps.passar;
    m.deps.passar = async () => {
      throw new Error("caiu");
    };
    expect(await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e2", min(5))))).toBeNull();
    expect(m.chave()?.passagem_evento_id).toBe("e2");
    m.deps.passar = passarDeVerdade;
    const r = await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e2", min(5))));
    expect(r?.status).toBe("ok");
    expect(m.passagens).toHaveLength(1);
    expect(m.avaliacoes).toHaveLength(2);
    expect(m.chave()).toBeNull();
  });

  it("espaçamento do número: volta quando libera e manda a nota uma vez só", async () => {
    const m = monta({ pacingLivreEm: new Date(T0.getTime() + 2_000) });
    const r1 = await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    expect(r1?.status).toBe("retry");
    expect(r1?.retry_at).toBe(new Date(T0.getTime() + 2_000).toISOString());
    expect(m.corpos).toHaveLength(0);
    m.liberaPacing();
    m.em(new Date(T0.getTime() + 2_000));
    await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    expect(m.corpos).toHaveLength(1);
    expect(m.avaliacoes).toHaveLength(1);
  });

  it("o CAS perdido volta em 5 s, sem passar e sem nota", async () => {
    const m = monta({ perdeCas: true });
    const r = await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    expect(r?.status).toBe("retry");
    expect(r?.retry_at).toBe(new Date(T0.getTime() + 5_000).toISOString());
    expect(m.corpos).toHaveLength(0);
    expect(m.passagens).toHaveLength(0);
  });

  it("dreno dentro da requisição adia sem avaliar", async () => {
    const m = monta({ origem: "request" });
    const r = await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    expect(r?.status).toBe("retry");
    expect(m.avaliacoes).toHaveLength(0);
    expect(m.chave()).toBeNull();
  });

  it("envio da nota recusado: a irritação fica, NÃO passa, e a repetição não reenvia", async () => {
    const m = monta({ falhaNoEnvio: true });
    const r = await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    expect(r).toEqual({ status: "skipped", detail: "tolerancia:seguiu_atendendo:nota_falhou" });
    expect(m.passagens).toHaveLength(0);
    expect(m.chave()).toMatchObject({ eventos: ["e1"], nota_evento_id: "e1" });
  });
});

describe("tolerância — a passagem de sempre (null)", () => {
  it.each([
    ["janela 0", { config: { sondagem_minutos: 0 } }],
    ["sem configuração", { config: null }],
    [
      "contato pessoal",
      { conversa: { contato: { is_personal: true, is_blocked: false, is_anonymized: false } } },
    ],
    [
      "contato bloqueado",
      { conversa: { contato: { is_personal: false, is_blocked: true, is_anonymized: false } } },
    ],
    [
      "anonimizado",
      { conversa: { contato: { is_personal: false, is_blocked: false, is_anonymized: true } } },
    ],
    ["sem contato na conversa", { conversa: { contato: null } }],
    ["grupo", { conversa: { is_group: true } }],
    ["humano assumiu (assignee_kind)", { conversa: { assignee_kind: "user" } }],
    ["humano assumiu (assigned_to_user_id)", { conversa: { assigned_to_user_id: "u-1" } }],
    ["a IA não é elegível", { elegivel: false }],
  ] as const)("%s → null, sem avaliar, sem gravar, sem nota", async (_nome, op) => {
    const m = monta(op as Opcoes);
    const r = await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    expect(r).toBeNull();
    expect(m.avaliacoes).toHaveLength(0);
    expect(m.chave()).toBeNull();
    expect(m.corpos).toHaveLength(0);
    expect(m.passagens).toHaveLength(0);
  });

  it("sem contato no alerta → null", async () => {
    const m = monta();
    expect(
      await aplicaToleranciaAoSentimento(m.deps, { ...ctx(evento("e1")), contactId: null }),
    ).toBeNull();
  });

  it("a avaliação lança → null (a passagem do upstream), sem irritação registrada", async () => {
    const m = monta();
    m.avalia(() => {
      throw new Error("modelo caiu");
    });
    const r = await aplicaToleranciaAoSentimento(m.deps, ctx(evento("e1")));
    expect(r).toBeNull();
    expect(m.chave()).toBeNull();
    expect(m.passagens).toHaveLength(0);
  });
});
