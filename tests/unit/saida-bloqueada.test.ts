/**
 * Fork elllo (saida1): SAÍDA BLOQUEADA por organização. Prova que, com a chave ligada,
 * NENHUM método do cliente do WAHA que escreve chega à rede, que a sessão nasce sem
 * "online", e (cerca) que todo método que escreve no WAHA e todo envio dos adaptadores
 * passa pela guarda. Com a chave vazia, nada muda.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SaidaBloqueadaError,
  barrarSaidaDaOrg,
  prefixoDaSessaoDaOrg,
  saidaBloqueadaDaOrg,
  sessaoDeOrgBloqueada,
} from "@/lib/channels/saida-bloqueada";
import { naturezaDaFalhaDeEnvio } from "@/lib/channels/falha-de-envio";
import { WahaClient } from "@/lib/waha/client";

const ORG = "a1b2c3d4-0000-4000-8000-000000000001";
const OUTRA = "ffffffff-0000-4000-8000-000000000002";
const SESSAO = `${prefixoDaSessaoDaOrg(ORG)}_55ae6e61221248108e41e65a95b3680d`;
const env = (v: string) => ({ SAIDA_BLOQUEADA_ORGS: v }) as unknown as NodeJS.ProcessEnv;
const RAIZ = process.cwd();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("saída bloqueada: a chave", () => {
  it("vazia = nada bloqueado; liga só a organização listada", () => {
    expect(saidaBloqueadaDaOrg(ORG, env(""))).toBe(false);
    expect(saidaBloqueadaDaOrg(ORG, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(saidaBloqueadaDaOrg(ORG, env(` ${OUTRA}, ${ORG.toUpperCase()} `))).toBe(true);
    expect(saidaBloqueadaDaOrg(OUTRA, env(ORG))).toBe(false);
  });
  it("a sessão do WAHA é reconhecida pelo prefixo da organização (as duas grafias do nome)", () => {
    expect(prefixoDaSessaoDaOrg(ORG)).toBe("org_a1b2c3d4");
    expect(sessaoDeOrgBloqueada(SESSAO, env(ORG))).toBe(true);
    expect(sessaoDeOrgBloqueada("org_a1b2c3d4", env(ORG))).toBe(true);
    expect(sessaoDeOrgBloqueada("org_a1b2c3d4x_1", env(ORG))).toBe(false);
    expect(sessaoDeOrgBloqueada(SESSAO, env(OUTRA))).toBe(false);
    expect(sessaoDeOrgBloqueada(SESSAO, env(""))).toBe(false);
  });
  it("o erro é falha PERMANENTE do canal: registra e não tenta de novo", () => {
    let e: unknown;
    try {
      barrarSaidaDaOrg(ORG, "teste", env(ORG));
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(SaidaBloqueadaError);
    expect(naturezaDaFalhaDeEnvio(e).natureza).toBe("permanente");
    expect(String((e as Error).message)).toMatch(/^saida_bloqueada:/);
  });
});

describe("saída bloqueada: nenhum método do cliente do WAHA chega à rede", () => {
  const chamadas = (c: WahaClient) => [
    () => c.sendMessage(SESSAO, "5567999990000@c.us", "oi"),
    () => c.sendSeen(SESSAO, "5567999990000@c.us"),
    () => c.rejectCall(SESSAO, "5567999990000@c.us", "call-1"),
    () => c.editMessage(SESSAO, "5567999990000@c.us", "m1", "x"),
    () => c.sendReaction(SESSAO, "m1", "👍"),
    () => c.deleteMessage(SESSAO, "5567999990000@c.us", "m1"),
    () => c.setPresence(SESSAO, "5567999990000@c.us", "typing"),
    () => c.sendContactVcard(SESSAO, "5567999990000@c.us", [] as never),
    () => c.sendMedia(SESSAO, "5567999990000@c.us", { endpoint: "/api/sendImage", payload: {} } as never),
    () => c.sendStatusImage(SESSAO, { mimetype: "image/jpeg", data: "x" }),
  ];

  it("com a chave ligada: os 10 métodos lançam SaidaBloqueadaError e o fetch nunca é chamado", async () => {
    vi.stubEnv("SAIDA_BLOQUEADA_ORGS", ORG);
    const rede = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", rede);
    const c = new WahaClient("http://waha.invalido", "chave");
    for (const chamar of chamadas(c)) {
      await expect(chamar()).rejects.toBeInstanceOf(SaidaBloqueadaError);
    }
    expect(rede).not.toHaveBeenCalled();
  });

  it("com a chave vazia: o envio vai à rede como sempre", async () => {
    vi.stubEnv("SAIDA_BLOQUEADA_ORGS", "");
    const rede = vi.fn(async () => new Response(JSON.stringify({ id: "true_x@c.us_ABC" }), { status: 200 }));
    vi.stubGlobal("fetch", rede);
    const c = new WahaClient("http://waha.invalido", "chave");
    await c.sendMessage(SESSAO, "5567999990000@c.us", "oi").catch(() => undefined);
    expect(rede).toHaveBeenCalled();
  });

  it("a sessão da organização bloqueada nasce com noweb.markOnline = false; a outra, como sempre", async () => {
    const corpos: unknown[] = [];
    const rede = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST" && init.body) corpos.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ statusCode: 500, error: "x", message: "x" }), { status: 500 });
    });
    vi.stubGlobal("fetch", rede);
    vi.stubEnv("SAIDA_BLOQUEADA_ORGS", ORG);
    const c = new WahaClient("http://waha.invalido", "chave");
    await c.createSession(SESSAO).catch(() => undefined);
    await c.createSession(`${prefixoDaSessaoDaOrg(OUTRA)}_1`).catch(() => undefined);
    const [bloqueada, outra] = corpos as Array<{ config: { noweb?: { markOnline?: boolean } } }>;
    expect(bloqueada!.config.noweb?.markOnline).toBe(false);
    expect(outra!.config.noweb).toBeUndefined();
  });
});

describe("CERCA: todo caminho de saída passa pela guarda", () => {
  it("todo método do cliente do WAHA que escreve (POST/PUT/DELETE) barra, salvo a gestão da sessão", () => {
    const src = readFileSync(path.join(RAIZ, "lib/waha/client.ts"), "utf8");
    const GESTAO_DA_SESSAO = new Set([
      "createSession", "startExistingSession", "convergirConfigDaSessao", "definirRecebimentoDeGrupos",
      "stopSession", "logoutSession", "deleteSession", "startSession",
    ]);
    const blocos = src.split(/\n  async /).slice(1);
    const semGuarda: string[] = [];
    for (const b of blocos) {
      const nome = b.slice(0, b.indexOf("("));
      const fim = b.search(/\n  (async |\/\*\*|private |[a-zA-Z]+\()/);
      const corpo = fim > 0 ? b.slice(0, fim) : b;
      const escreve = /method: "(POST|PUT|DELETE)"/.test(corpo);
      if (escreve && !GESTAO_DA_SESSAO.has(nome) && !corpo.includes("barrarSaidaDaSessao(session")) semGuarda.push(nome);
    }
    expect(semGuarda).toEqual([]);
  });
  it("todo envio dos adaptadores de canal barra", () => {
    const dir = path.join(RAIZ, "lib/channels/adapters");
    for (const arq of ["datafy.ts", "meta-cloud.ts", "telegram.ts", "waha.ts", "zernio.ts"]) {
      const src = readFileSync(path.join(dir, arq), "utf8");
      for (const bloco of src.split(/\n  async /).slice(1)) {
        const nome = bloco.slice(0, bloco.indexOf("("));
        if (!["send", "sendReaction", "sendTemplate"].includes(nome)) continue;
        const inicio = bloco.slice(0, bloco.indexOf("{\n", bloco.indexOf(")")) + 200);
        expect(inicio, `${arq}: ${nome} sem guarda`).toMatch(/barrarSaida(DaOrg|DaSessao)\(/);
      }
    }
  });
  it("o redrive do watchdog (o único envio sem o cliente) barra antes do sendText", () => {
    const src = readFileSync(path.join(RAIZ, "lib/agent-engine/edge/crm/session-reconciler.ts"), "utf8");
    const guarda = src.indexOf("sessaoDeOrgBloqueada(m.waha_session_name)");
    const envio = src.indexOf("/api/sendText");
    expect(guarda).toBeGreaterThan(0);
    expect(guarda).toBeLessThan(envio);
  });
  it("nenhum outro arquivo fala com os endpoints de envio do WAHA por fora do cliente", () => {
    const proibido = /\/api\/(sendText|sendImage|sendFile|sendVoice|sendVideo|sendSeen|reaction|sendContactVcard)/;
    const permitidos = new Set(["lib/waha/client.ts", "lib/agent-engine/edge/crm/session-reconciler.ts"]);
    const achados: string[] = [];
    const varrer = (rel: string) => {
      const abs = path.join(RAIZ, rel);
      for (const nome of readdirSync(abs, { recursive: true }) as string[]) {
        if (!/\.tsx?$/.test(nome) || /\.test\.tsx?$/.test(nome)) continue;
        const relArq = path.posix.join(rel, nome.split(path.sep).join("/"));
        if (permitidos.has(relArq)) continue;
        const codigo = readFileSync(path.join(abs, nome), "utf8")
          .split("\n")
          .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
          .join("\n");
        if (proibido.test(codigo)) achados.push(relArq);
      }
    };
    varrer("lib");
    varrer("app");
    expect(achados).toEqual([]);
  });
});
