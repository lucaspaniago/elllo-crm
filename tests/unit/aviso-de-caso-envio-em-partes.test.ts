/**
 * O AVISO DE CASO EM PARTES SAI UMA PARTE POR RODADA, SEM REPETIR NENHUMA (fork elllo).
 *
 * Com «Responder casos por este WhatsApp» ligado, `aplicaAvisoDeCaso` manda as
 * sete partes de `montarPartesDoAvisoDeCaso` uma por invocação: grava o
 * progresso em `partes_enviadas`, devolve `retry` para a próxima e NUNCA dorme.
 * As garantias medidas aqui:
 *
 *   - a 1ª invocação manda só a parte 1 e pede a volta;
 *   - a reentrada com 3 já enviadas manda a 4ª, sem a janela de reivindicação
 *     dos 2 minutos (que só protege a primeira parte);
 *   - o pacing é consultado e registrado a cada parte;
 *   - uma falha numa parte nunca reenvia as anteriores; três falhas com partes
 *     já no celular da equipe encerram como `enviado` incompleto, sem Central;
 *   - a última parte grava `enviado`, o hash das partes unidas e audita UMA vez;
 *   - desligado: um envio só, com o mesmo texto e o mesmo hash de sempre.
 *
 * Os dublês são os de `aviso-de-caso-idempotencia.test.ts`, com o falso da
 * entrega guardando o estado entre as invocações.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  EVENTO_CASO_ABERTO,
  JANELA_DE_REIVINDICACAO_MS,
  TETO_DE_TENTATIVAS_DE_ENVIO,
  aplicaAvisoDeCaso,
  type AvisoDeps,
} from "@/lib/escalacao/aviso-ao-suporte";
import { FOLGA_ENTRE_PARTES_MS } from "@/lib/escalacao/envio-em-partes";
import { montarAvisoDeCaso, montarPartesDoAvisoDeCaso } from "@/lib/escalacao/texto-do-aviso";
import type { EventRow } from "@/lib/event-log/dispatcher";

const AGORA = new Date("2026-09-18T14:00:00.000Z");
const ORG = "11111111-1111-4111-8111-111111111111";
const CASO = "22222222-2222-4222-8222-222222222222";
const CANAL = "55555555-5555-4555-8555-555555555555";
const DESTINO = "+5531998966398";
const URL_PUBLICA = "https://crm.exemplo.com.br";

const ROW: EventRow = {
  id: "66666666-6666-4666-8666-666666666666",
  organization_id: ORG,
  event_type: EVENTO_CASO_ABERTO,
  entity_kind: "agent_case",
  entity_id: CASO,
  payload: { case_id: CASO, conversation_id: "c", contact_id: "d", source: "agent" },
  metadata: {},
  consumed_by: [],
  attempts: 0,
  created_at: new Date(AGORA.getTime() - 30_000).toISOString(),
};

const AVISO = {
  marca: "Acme",
  idioma: "pt-BR" as const,
  kind: "financeiro",
  source: "agent",
  title: "t",
  summary: "s",
  blocker: "b",
  caseId: CASO,
  nomeDoCliente: "Maria",
  link: `${URL_PUBLICA}/app/ai/cases?caso=${CASO}`,
};

interface Opcoes {
  ligado?: boolean;
  /** Linha que já existe (reentrada); null = primeira vez. */
  existente?: Record<string, unknown> | null;
  /** Índices (0-based) de parte cujo envio o transporte recusa. */
  falhaNasPartes?: number[];
  pacingRecusaAte?: Date | null;
}

function entregaBase(over: Record<string, unknown> = {}) {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    organization_id: ORG,
    case_id: CASO,
    destino: DESTINO,
    status: "pendente",
    tentativas: 0,
    partes_enviadas: 0,
    created_at: new Date(AGORA.getTime() - 60_000).toISOString(),
    updated_at: new Date(AGORA.getTime() - 60_000).toISOString(),
    ...over,
  };
}

function monta(op: Opcoes = {}) {
  const ligado = op.ligado ?? true;
  const corpos: string[] = [];
  const patches: Array<Record<string, unknown>> = [];
  const central: unknown[] = [];
  const auditorias: Array<{ action: string; metadata: Record<string, unknown> }> = [];
  const eventosDoCaso: unknown[] = [];
  const jids: string[] = [];
  const pacing = { decide: 0, registra: 0 };
  // O estado da linha de entrega, que o falso mantém entre as invocações —
  // é o que o banco faria com `atualizaEntrega`.
  let linha: Record<string, unknown> | null = op.existente ?? null;
  let tentativaDoEnvio = 0;

  const deps: AvisoDeps = {
    clock: () => AGORA,
    urlPublica: URL_PUBLICA,
    origemDoDreno: () => "worker",
    audita: (e) => auditorias.push({ action: e.action, metadata: e.metadata }),
    db: {
      async carregaConfig() {
        return {
          organization_id: ORG,
          channel_session_id: CANAL,
          telefone_destino: DESTINO,
          destino_jid: null,
          ligado: true,
          resposta_whatsapp_habilitada: ligado,
        };
      },
      async carregaCaso() {
        return {
          id: CASO,
          organization_id: ORG,
          conversation_id: "c",
          kind: "financeiro",
          source: "agent",
          status: "awaiting_human",
          title: "t",
          summary: "s",
          blocker: "b",
        };
      },
      async contatoAnonimizado() {
        return false;
      },
      async reivindicaEntrega(entrada) {
        if (linha) return { criada: false, entrega: { ...linha } as never };
        linha = entregaBase({ destino: entrada.destino });
        return { criada: true, entrega: { ...linha } as never };
      },
      async atualizaEntrega(_org, _id, patch) {
        patches.push(patch as Record<string, unknown>);
        linha = { ...(linha ?? {}), ...patch };
      },
      async cancelaPendentesDoCaso() {
        return 0;
      },
      async carregaCanal() {
        return { id: CANAL, status: "WORKING", archived_at: null, aceitaMensagemLivre: true };
      },
      async destinoEhDaPropriaOrganizacao() {
        return false;
      },
      async avisaNaCentral(e) {
        central.push(e);
      },
      async registraEventoDoCaso(e) {
        eventosDoCaso.push(e);
      },
      async registraJidDoAviso(_org, jid) {
        jids.push(jid);
      },
      async nomeDoContato() {
        return "Maria";
      },
      async marcaDaOrganizacao() {
        return { nome: "Acme", idioma: "pt-BR" as const };
      },
    },
    transporte: {
      async configurado() {
        return true;
      },
      async resolveDestino(_org, _canal, tel) {
        return `${tel.replace(/\D/g, "")}@c.us`;
      },
      async envia(_org, _canal, _to, body) {
        const indice = Number((linha?.partes_enviadas as number | undefined) ?? 0);
        tentativaDoEnvio += 1;
        if (op.falhaNasPartes?.includes(indice)) throw new Error("recusado pelo provedor");
        corpos.push(body);
        return { externalId: `wamid.${indice + 1}` };
      },
    },
    pacing: {
      async decide() {
        pacing.decide += 1;
        if (op.pacingRecusaAte) {
          return { liberado: false, motivo: "espacamento", liberaEm: op.pacingRecusaAte };
        }
        return { liberado: true };
      },
      async registraEnvio() {
        pacing.registra += 1;
      },
    },
  };
  return {
    deps,
    corpos,
    patches,
    central,
    auditorias,
    eventosDoCaso,
    jids,
    pacing,
    linha: () => linha,
    tentativasDoTransporte: () => tentativaDoEnvio,
  };
}

const PARTES = montarPartesDoAvisoDeCaso({ ...AVISO, respostaWhatsappHabilitada: true });

describe("aviso de caso em partes — o envio", () => {
  it("1ª invocação: manda SÓ a parte 1, grava o progresso e pede a volta", async () => {
    const m = monta();
    const r = await aplicaAvisoDeCaso(m.deps, ROW);
    expect(r.status).toBe("retry");
    expect(r.detail).toBe("parte 1/7");
    expect(m.corpos).toEqual([PARTES[0]]);
    expect(m.linha()).toMatchObject({ partes_enviadas: 1, external_id: "wamid.1", status: "pendente" });
    // A volta sai agora + 1 s quando o pacing libera — nunca dorme no handler.
    expect(r.retry_at).toBe(new Date(AGORA.getTime() + FOLGA_ENTRE_PARTES_MS).toISOString());
    // O JID é registrado já na primeira parte.
    expect(m.jids).toEqual(["5531998966398@c.us"]);
    // Nada de "enviado" antes da última parte.
    expect(m.auditorias).toHaveLength(0);
    expect(m.eventosDoCaso).toHaveLength(0);
  });

  it("reentrada com 3 enviadas e updated_at recente: manda a 4ª, sem esperar a janela", async () => {
    const m = monta({
      existente: entregaBase({
        partes_enviadas: 3,
        external_id: "wamid.1",
        updated_at: new Date(AGORA.getTime() - 2_000).toISOString(),
      }),
    });
    expect(2_000).toBeLessThan(JANELA_DE_REIVINDICACAO_MS);
    const r = await aplicaAvisoDeCaso(m.deps, ROW);
    expect(r.status).toBe("retry");
    expect(r.detail).toBe("parte 4/7");
    expect(m.corpos).toEqual([PARTES[3]]);
    expect(m.corpos[0]).toBe(`RESPONDER ${CASO} <resposta ou decisão>`);
    // O external_id da parte 1 não é sobrescrito pelas seguintes.
    expect(m.patches.at(-1)).not.toHaveProperty("external_id");
    expect(m.linha()).toMatchObject({ partes_enviadas: 4, external_id: "wamid.1" });
  });

  it("a janela de 2 min continua valendo para a PRIMEIRA parte (crash antes de gravar)", async () => {
    const m = monta({
      existente: entregaBase({ updated_at: new Date(AGORA.getTime() - 30_000).toISOString() }),
    });
    const r = await aplicaAvisoDeCaso(m.deps, ROW);
    expect(r.status).toBe("retry");
    expect(m.corpos).toHaveLength(0);
  });

  it("pacing por parte: consulta antes, registra depois, e a próxima volta segue o liberaEm", async () => {
    const m = monta();
    await aplicaAvisoDeCaso(m.deps, ROW);
    // decide antes do envio (passo 11) + decide para marcar a próxima parte.
    expect(m.pacing.decide).toBe(2);
    expect(m.pacing.registra).toBe(1);

    const liberaEm = new Date(AGORA.getTime() + 30_000);
    const recusado = monta({ existente: entregaBase({ partes_enviadas: 2 }), pacingRecusaAte: liberaEm });
    const r = await aplicaAvisoDeCaso(recusado.deps, ROW);
    // Espaçado: a parte não sai e a volta é no instante que o pacing deu.
    expect(r.status).toBe("retry");
    expect(r.retry_at).toBe(liberaEm.toISOString());
    expect(recusado.corpos).toHaveLength(0);
  });

  it("a sequência inteira: sete envios na ordem, um por rodada, sem repetir parte", async () => {
    const m = monta();
    const desfechos: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await aplicaAvisoDeCaso(m.deps, ROW);
      desfechos.push(r.status);
    }
    expect(desfechos).toEqual(["retry", "retry", "retry", "retry", "retry", "retry", "ok"]);
    expect(m.corpos).toEqual(PARTES);
    expect(m.pacing.registra).toBe(7);
    // Uma oitava rodada (reentrega do dreno) não manda nada.
    const r = await aplicaAvisoDeCaso(m.deps, ROW);
    expect(r.status).toBe("skipped");
    expect(m.corpos).toHaveLength(7);
  });

  it("falha na 4ª parte: não reenvia as anteriores, guarda a tentativa e tenta a MESMA parte depois", async () => {
    const m = monta({ existente: entregaBase({ partes_enviadas: 3 }), falhaNasPartes: [3] });
    const r = await aplicaAvisoDeCaso(m.deps, ROW);
    expect(r.status).toBe("retry");
    expect(m.corpos).toHaveLength(0);
    expect(m.linha()).toMatchObject({
      partes_enviadas: 3,
      tentativas: 1,
      erro_codigo: "falha_no_envio",
      status: "pendente",
    });
    expect(m.central).toHaveLength(0);
  });

  it("três falhas com partes já entregues → `enviado` incompleto, sem Central, auditado com metadata.incompleto", async () => {
    const m = monta({
      existente: entregaBase({ partes_enviadas: 3, external_id: "wamid.1" }),
      falhaNasPartes: [3],
    });
    for (let i = 0; i < TETO_DE_TENTATIVAS_DE_ENVIO; i++) {
      await aplicaAvisoDeCaso(m.deps, ROW);
    }
    expect(m.tentativasDoTransporte()).toBe(TETO_DE_TENTATIVAS_DE_ENVIO);
    expect(m.corpos).toHaveLength(0);
    expect(m.linha()).toMatchObject({
      status: "enviado",
      erro_codigo: "falha_no_envio",
      partes_enviadas: 3,
      external_id: "wamid.1",
    });
    expect(String(m.linha()?.erro_detalhe)).toMatch(/^incompleto 3\/7: recusado pelo provedor/);
    // O aviso CHEGOU (o corpo e o link estão lá): a Central não diz que não chegou.
    expect(m.central).toHaveLength(0);
    expect(m.auditorias).toEqual([
      expect.objectContaining({
        action: "ai.case_alert_sent",
        metadata: expect.objectContaining({ incompleto: "3/7", partes: 7 }),
      }),
    ]);
    // E a rodada seguinte não tenta mais nada.
    const r = await aplicaAvisoDeCaso(m.deps, ROW);
    expect(r.status).toBe("skipped");
    expect(m.tentativasDoTransporte()).toBe(TETO_DE_TENTATIVAS_DE_ENVIO);
  });

  it("três falhas na PRIMEIRA parte → falhou, como antes do fork (nada chegou)", async () => {
    const m = monta({ falhaNasPartes: [0] });
    const reentrada = { updated_at: new Date(AGORA.getTime() - 10 * 60_000).toISOString() };
    for (let i = 0; i < TETO_DE_TENTATIVAS_DE_ENVIO; i++) {
      await aplicaAvisoDeCaso(m.deps, ROW);
      // Reivindicação antiga: a janela dos 2 min não segura a nova tentativa.
      const linha = m.linha();
      if (linha) Object.assign(linha, reentrada);
    }
    expect(m.linha()).toMatchObject({ status: "falhou", erro_codigo: "falha_no_envio" });
    expect(m.central).toHaveLength(1);
  });

  it("última parte: `enviado`, partes_enviadas 7, hash das partes unidas, alert_sent e auditoria UMA vez", async () => {
    const m = monta({ existente: entregaBase({ partes_enviadas: 6, external_id: "wamid.1" }) });
    const r = await aplicaAvisoDeCaso(m.deps, ROW);
    expect(r.status).toBe("ok");
    expect(m.corpos).toEqual([PARTES[6]]);
    const hash = createHash("sha256").update(PARTES.join("\n")).digest("hex");
    expect(m.linha()).toMatchObject({
      status: "enviado",
      partes_enviadas: 7,
      external_id: "wamid.1",
      corpo_hash: hash,
      erro_codigo: null,
    });
    expect(m.eventosDoCaso).toHaveLength(1);
    expect(m.auditorias).toHaveLength(1);
    expect(m.auditorias[0]).toMatchObject({ action: "ai.case_alert_sent" });
    // O pacing desta parte foi registrado UMA vez (por `enviarParte`), não duas.
    expect(m.pacing.registra).toBe(1);
  });
});

describe("aviso de caso em partes — desligado (regressão)", () => {
  it("um envio só, o texto de sempre, o hash de sempre, sem partes_enviadas", async () => {
    const m = monta({ ligado: false });
    const r = await aplicaAvisoDeCaso(m.deps, ROW);
    expect(r.status).toBe("ok");
    const texto = montarAvisoDeCaso({ ...AVISO, respostaWhatsappHabilitada: false });
    expect(m.corpos).toEqual([texto]);
    const ultimo = m.patches.at(-1) ?? {};
    expect(ultimo).toMatchObject({
      status: "enviado",
      tentativas: 1,
      erro_codigo: null,
      erro_detalhe: null,
      external_id: "wamid.1",
      corpo_hash: createHash("sha256").update(texto).digest("hex"),
    });
    expect(ultimo).not.toHaveProperty("partes_enviadas");
    expect(m.patches).toHaveLength(1);
    expect(m.pacing.registra).toBe(1);
    expect(m.auditorias).toHaveLength(1);
    expect(m.auditorias[0]?.metadata).not.toHaveProperty("partes");
  });
});
