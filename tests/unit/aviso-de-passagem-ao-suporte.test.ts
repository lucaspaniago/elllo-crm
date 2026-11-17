/**
 * O AVISO DE PASSAGEM AO DONO (fork elllo) — quando sai, quando não sai, e como sai.
 *
 * A regra é a irmã de `aplicaAvisoDeCaso`, sobre dublês: configuração,
 * passagem, contato e conversa falsos; transporte e pacing que só contam. O que
 * se mede:
 *
 *   - os pulos da decisão do dono (caso, pessoal, anonimizado, grupo, alguém
 *     assumiu, outra passagem avisada há pouco), todos ANTES de qualquer rede;
 *   - o dreno em requisição adia; sem configuração pula; evento velho pula;
 *   - duas partes, uma por rodada: o conteúdo (com a avaliação, só aqui) e o
 *     link; o texto do modelo não volta ao banco, só a hipótese e o hash;
 *   - a reivindicação idempotente (23505 → relida) e a janela só na 1ª parte;
 *   - a prontidão do canal espelhada do aviso de caso, e a falha definitiva
 *     como `falhou` sem nunca devolver `error`.
 */
import { describe, expect, it } from "vitest";

import { EVENTO_PASSAGEM_REGISTRADA } from "@/lib/escalacao/vocabulario-do-aviso-de-passagem";
import {
  aplicaAvisoDePassagem,
  lerMensagemQueDisparou,
  type AvisoDePassagemDeps,
  type ContatoDoAvisoDePassagem,
  type ConversaDoAvisoDePassagem,
  type PassagemDoAviso,
} from "@/lib/escalacao/aviso-de-passagem-ao-suporte";
import { TETO_DE_TENTATIVAS_DE_ENVIO } from "@/lib/escalacao/aviso-ao-suporte";
import type { MensagemParaAvaliar } from "@/lib/escalacao/avaliacao-da-passagem";
import type { EventRow } from "@/lib/event-log/dispatcher";

const AGORA = new Date("2026-10-25T14:00:00.000Z");
const ORG = "11111111-1111-4111-8111-111111111111";
const PASSAGEM = "33333333-3333-4333-8333-333333333333";
const CONVERSA = "44444444-4444-4444-8444-444444444444";
const CONTATO = "55555555-5555-4555-8555-555555555555";
const CANAL = "66666666-6666-4666-8666-666666666666";
const DESTINO = "+5531998966398";

const ROW: EventRow = {
  id: "77777777-7777-4777-8777-777777777777",
  organization_id: ORG,
  event_type: EVENTO_PASSAGEM_REGISTRADA,
  entity_kind: "passagem_de_atendimento",
  entity_id: PASSAGEM,
  payload: { passagem_id: PASSAGEM, conversation_id: CONVERSA, contact_id: CONTATO, motivo_codigo: "low_sentiment" },
  metadata: {},
  consumed_by: [],
  attempts: 0,
  created_at: new Date(AGORA.getTime() - 20_000).toISOString(),
};

const MENSAGENS: MensagemParaAvaliar[] = [
  {
    direction: "inbound",
    sent_via: null,
    body: "isso é um absurdo",
    metadata: null,
    created_at: new Date(AGORA.getTime() - 15 * 60_000).toISOString(),
  },
  {
    direction: "outbound",
    sent_via: "ai",
    body: "Entendo, vou verificar o boleto para você.",
    metadata: null,
    created_at: new Date(AGORA.getTime() - 14 * 60_000).toISOString(),
  },
];

interface Opcoes {
  config?: Record<string, unknown> | null;
  passagem?: Partial<PassagemDoAviso> | null;
  contato?: Partial<ContatoDoAvisoDePassagem> | null;
  conversa?: Partial<ConversaDoAvisoDePassagem> | null;
  casoJaAvisado?: boolean;
  outraAvisada?: boolean;
  existente?: Record<string, unknown> | null;
  origem?: "worker" | "request";
  canal?: Record<string, unknown>;
  falhaNoEnvio?: boolean;
  avaliacaoDisponivel?: boolean;
}

function monta(op: Opcoes = {}) {
  const corpos: string[] = [];
  const patches: Array<Record<string, unknown>> = [];
  const leituras: string[] = [];
  let avaliacoes = 0;
  let linha: Record<string, unknown> | null = op.existente ?? null;

  const deps: AvisoDePassagemDeps = {
    clock: () => AGORA,
    urlPublica: "https://crm.exemplo.com.br",
    origemDoDreno: () => op.origem ?? "worker",
    async avaliar() {
      avaliacoes += 1;
      return op.avaliacaoDisponivel === false
        ? { disponivel: false, porque: "orcamento_de_ia" }
        : {
            disponivel: true,
            hipotese: "irritacao_real",
            confianca: 0.9,
            indicios: ["reclamou duas vezes"],
            recomendacao: "ligar para o cliente",
            contexto: "boleto atrasado",
          };
    },
    db: {
      async carregaConfig() {
        leituras.push("config");
        if (op.config === null) return null;
        return {
          organization_id: ORG,
          channel_session_id: CANAL,
          telefone_destino: DESTINO,
          ligado: true,
          aviso_de_passagem_ligado: true,
          sondagem_minutos: 10,
          ...(op.config ?? {}),
        } as never;
      },
      async carregaPassagem() {
        if (op.passagem === null) return null;
        return {
          id: PASSAGEM,
          organization_id: ORG,
          conversation_id: CONVERSA,
          contact_id: CONTATO,
          caso_id: null,
          motivo_codigo: "low_sentiment",
          criado_em: new Date(AGORA.getTime() - 30_000).toISOString(),
          reconhecido_em: null,
          ...(op.passagem ?? {}),
        };
      },
      async carregaConversa() {
        return { is_group: false, assignee_kind: "ai", ...(op.conversa ?? {}) };
      },
      async carregaContato() {
        return { nome: "Maria Souza", is_personal: false, is_anonymized: false, ...(op.contato ?? {}) };
      },
      async casoJaAvisado() {
        return op.casoJaAvisado ?? false;
      },
      async outraPassagemAvisada() {
        return op.outraAvisada ?? false;
      },
      async reivindicaEntrega(e) {
        if (linha) return { criada: false, entrega: { ...linha } as never };
        linha = {
          id: "88888888-8888-4888-8888-888888888888",
          organization_id: ORG,
          passagem_id: e.passagemId,
          destino: e.destino,
          status: "pendente",
          tentativas: 0,
          partes_enviadas: 0,
          created_at: new Date(AGORA.getTime() - 1000).toISOString(),
          updated_at: new Date(AGORA.getTime() - 1000).toISOString(),
        };
        return { criada: true, entrega: { ...linha } as never };
      },
      async atualizaEntrega(_o, _i, patch) {
        patches.push(patch as Record<string, unknown>);
        linha = { ...(linha ?? {}), ...patch };
      },
      async mensagensAte() {
        leituras.push("mensagens");
        return MENSAGENS;
      },
    },
    canais: {
      async carregaCanal() {
        return {
          id: CANAL,
          status: "WORKING",
          archived_at: null,
          aceitaMensagemLivre: true,
          ...(op.canal ?? {}),
        } as never;
      },
      async destinoEhDaPropriaOrganizacao() {
        return false;
      },
      async registraJidDoAviso() {},
      async marcaDaOrganizacao() {
        return { nome: "Acme", idioma: "pt-BR" as const };
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
        return { liberado: true };
      },
      async registraEnvio() {},
    },
  };
  return { deps, corpos, patches, leituras, linha: () => linha, avaliacoes: () => avaliacoes };
}

describe("aviso de passagem — os pulos", () => {
  it.each([
    ["caso_escalado", { passagem: { motivo_codigo: "caso_escalado" as const } }],
    ["ja_houve_aviso_de_caso", { passagem: { caso_id: "c" }, casoJaAvisado: true }],
    ["contato_pessoal", { contato: { is_personal: true } }],
    ["titular_anonimizado", { contato: { is_anonymized: true } }],
    ["grupo", { conversa: { is_group: true } }],
    ["humano_assumiu", { conversa: { assignee_kind: "user" } }],
    ["humano_assumiu", { passagem: { reconhecido_em: AGORA.toISOString() } }],
    ["outra_passagem_avisada_ha_pouco", { outraAvisada: true }],
    ["sem_configuracao", { config: null }],
    ["sem_configuracao", { config: { aviso_de_passagem_ligado: false } }],
    ["sem_configuracao", { config: { ligado: false } }],
    ["passagem_inexistente", { passagem: null }],
  ] as const)("%s → skipped, sem envio e sem linha", async (detalhe, op) => {
    const m = monta(op as Opcoes);
    const r = await aplicaAvisoDePassagem(m.deps, ROW);
    expect(r).toEqual({ status: "skipped", detail: detalhe });
    expect(m.corpos).toHaveLength(0);
    expect(m.linha()).toBeNull();
  });

  it("caso sem aviso de caso NÃO pula: a equipe ainda não soube", async () => {
    const m = monta({ passagem: { caso_id: "c" }, casoJaAvisado: false });
    const r = await aplicaAvisoDePassagem(m.deps, ROW);
    expect(r.status).toBe("retry");
    expect(m.corpos).toHaveLength(1);
  });

  it("dreno dentro da requisição adia 15 s sem ler nada", async () => {
    const m = monta({ origem: "request" });
    const r = await aplicaAvisoDePassagem(m.deps, ROW);
    expect(r.status).toBe("retry");
    expect(m.leituras).toHaveLength(0);
  });

  it("evento com mais de 30 min pula", async () => {
    const m = monta();
    const r = await aplicaAvisoDePassagem(m.deps, {
      ...ROW,
      created_at: new Date(AGORA.getTime() - 31 * 60_000).toISOString(),
    });
    expect(r).toEqual({ status: "skipped", detail: "evento_velho" });
  });
});

describe("aviso de passagem — o envio em duas partes", () => {
  it("1ª rodada: o conteúdo, com avaliação; grava hipótese e hash, nunca o texto", async () => {
    const m = monta();
    const r = await aplicaAvisoDePassagem(m.deps, ROW);
    expect(r).toMatchObject({ status: "retry", detail: "parte 1/2" });
    expect(m.corpos).toHaveLength(1);
    expect(m.corpos[0]).toContain("🔔 Acme: atendimento passou para você");
    expect(m.corpos[0]).toContain('Mensagem que disparou: "isso é um absurdo"');
    expect(m.corpos[0]).not.toContain("Sondagem");
    expect(m.corpos[0]).toContain("Avaliação da IA: provável irritação real (90%)");
    expect(m.avaliacoes()).toBe(1);
    const patch = m.patches.at(-1)!;
    expect(patch).toMatchObject({ partes_enviadas: 1, hipotese: "irritacao_real", external_id: "wamid.1" });
    expect(patch.corpo_hash).toMatch(/^[0-9a-f]{64}$/);
    // Nenhuma coluna guarda o texto.
    for (const v of Object.values(patch)) {
      if (typeof v === "string") expect(v).not.toContain("absurdo");
    }
  });

  it("2ª rodada: só o link, sem nova avaliação nem leitura de mensagens; fecha como enviado", async () => {
    const m = monta();
    await aplicaAvisoDePassagem(m.deps, ROW);
    const leiturasAntes = m.leituras.filter((l) => l === "mensagens").length;
    const r = await aplicaAvisoDePassagem(m.deps, ROW);
    expect(r.status).toBe("ok");
    expect(m.corpos[1]).toBe(`Abrir: https://crm.exemplo.com.br/app/inbox?id=${CONVERSA}`);
    expect(m.avaliacoes()).toBe(1);
    expect(m.leituras.filter((l) => l === "mensagens").length).toBe(leiturasAntes);
    expect(m.linha()).toMatchObject({ status: "enviado", partes_enviadas: 2, hipotese: "irritacao_real" });
    // Uma terceira rodada não manda nada.
    const r3 = await aplicaAvisoDePassagem(m.deps, ROW);
    expect(r3.status).toBe("skipped");
    expect(m.corpos).toHaveLength(2);
  });

  it("avaliação indisponível: o aviso sai mesmo assim, sem hipótese", async () => {
    const m = monta({ avaliacaoDisponivel: false });
    await aplicaAvisoDePassagem(m.deps, ROW);
    expect(m.corpos[0]).toContain("Avaliação indisponível");
    expect(m.patches.at(-1)).toMatchObject({ hipotese: null });
  });

  it("reivindicação recente na 1ª parte espera; com a 1ª enviada, segue sem esperar", async () => {
    const recente = new Date(AGORA.getTime() - 10_000).toISOString();
    const base = {
      id: "88888888-8888-4888-8888-888888888888",
      organization_id: ORG,
      passagem_id: PASSAGEM,
      destino: DESTINO,
      status: "pendente",
      tentativas: 0,
      created_at: recente,
      updated_at: recente,
    };
    const parada = monta({ existente: { ...base, partes_enviadas: 0 } });
    expect((await aplicaAvisoDePassagem(parada.deps, ROW)).status).toBe("retry");
    expect(parada.corpos).toHaveLength(0);

    const segue = monta({ existente: { ...base, partes_enviadas: 1 } });
    expect((await aplicaAvisoDePassagem(segue.deps, ROW)).status).toBe("ok");
    expect(segue.corpos).toHaveLength(1);
  });

  it("canal pausado → falhou:canal_desativado, sem envio e sem `error`", async () => {
    const m = monta({ canal: { desativado: true } });
    const r = await aplicaAvisoDePassagem(m.deps, ROW);
    expect(r).toEqual({ status: "skipped", detail: "falhou:canal_desativado" });
    expect(m.linha()).toMatchObject({ status: "falhou", erro_codigo: "canal_desativado" });
  });

  it("canal desconectado → retry com tentativa contada", async () => {
    const m = monta({ canal: { status: "STOPPED" } });
    const r = await aplicaAvisoDePassagem(m.deps, ROW);
    expect(r.status).toBe("retry");
    expect(m.linha()).toMatchObject({ tentativas: 1, erro_codigo: "canal_desconectado" });
  });

  it("três recusas do transporte na 1ª parte → falhou:falha_no_envio", async () => {
    const velho = new Date(AGORA.getTime() - 10 * 60_000).toISOString();
    const m = monta({ falhaNoEnvio: true });
    let r;
    for (let i = 0; i < TETO_DE_TENTATIVAS_DE_ENVIO; i++) {
      r = await aplicaAvisoDePassagem(m.deps, ROW);
      const l = m.linha();
      if (l) l.updated_at = velho;
    }
    expect(r).toEqual({ status: "skipped", detail: "falhou:falha_no_envio" });
    expect(m.linha()).toMatchObject({ status: "falhou" });
  });
});

describe("lerMensagemQueDisparou", () => {
  const em = (min: number) => new Date(AGORA.getTime() - min * 60_000).toISOString();

  it("a última fala do cliente antes da passagem; o que veio depois não conta", () => {
    const r = lerMensagemQueDisparou(
      [
        { direction: "inbound", sent_via: null, body: "primeira", metadata: null, created_at: em(5) },
        { direction: "outbound", sent_via: "ai", body: "resposta", metadata: null, created_at: em(4) },
        { direction: "inbound", sent_via: null, body: "segunda", metadata: null, created_at: em(3) },
        { direction: "inbound", sent_via: null, body: "depois", metadata: null, created_at: em(-5) },
      ],
      AGORA,
    );
    expect(r).toBe("segunda");
  });

  it("sem fala do cliente com texto: null", () => {
    const r = lerMensagemQueDisparou(
      [{ direction: "outbound", sent_via: "ai", body: "oi", metadata: null, created_at: em(1) }],
      AGORA,
    );
    expect(r).toBeNull();
  });
});
