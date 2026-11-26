/**
 * Fork elllo (teste1): o modo teste do Hermes pelo CRM. A prova com banco e modelo de
 * verdade está no ensaio da sessão 4 (sobra zero, efeitos zero); aqui, as regras puras e
 * a CERCA de que a rota e o módulo não ganham caminho de envio, handoff ou fila.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  IDADE_DO_PENTE_MINUTOS,
  PREFIXO_DO_NOME,
  TAG_DO_TESTE,
  nomeDoContatoDeTeste,
  somaDosEfeitos,
  testeDoHermesLigado,
} from "@/lib/teste-do-hermes/teste-do-hermes";
import { isPublicPath } from "@/lib/auth/public-paths";

const env = (v: string) => ({ TESTE_DO_HERMES_ORGS: v }) as unknown as NodeJS.ProcessEnv;
const ORG = "4d9f40e1-e122-45a8-8693-7c3527d0fe78";

describe("modo teste do Hermes (teste1)", () => {
  it("desligado por padrão; liga só a organização listada (serve a qualquer instalação)", () => {
    expect(testeDoHermesLigado(ORG, env(""))).toBe(false);
    expect(testeDoHermesLigado(ORG, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(testeDoHermesLigado(ORG, env(` outra , ${ORG} `))).toBe(true);
    expect(testeDoHermesLigado("outra-org", env(ORG))).toBe(false);
  });
  it("o nome do contato de teste é marcado e curto, sem quebra de linha", () => {
    expect(nomeDoContatoDeTeste("dona de academia")).toBe(`${PREFIXO_DO_NOME}dona de academia (apagar)`);
    expect(nomeDoContatoDeTeste("")).toBe(`${PREFIXO_DO_NOME}cliente (apagar)`);
    expect(nomeDoContatoDeTeste("a\nb\tc")).toBe(`${PREFIXO_DO_NOME}a b c (apagar)`);
    expect(nomeDoContatoDeTeste("x".repeat(500)).length).toBeLessThan(90);
    expect(TAG_DO_TESTE).toBe("teste-hermes");
    expect(IDADE_DO_PENTE_MINUTOS).toBe(120);
  });
  it("efeitos somam tudo o que não pode existir", () => {
    const zero = { casos: 0, compromissos: 0, jobs: 0, retornos: 0, eventos: 0, passagens: 0, agendadas: 0, envios: 0, mensagensComEnvio: 0, apanhado: 0 };
    expect(somaDosEfeitos(zero)).toBe(0);
    expect(somaDosEfeitos({ ...zero, casos: 1, jobs: 2 })).toBe(3);
  });
  it("a rota tem porta de token no proxy", () => {
    expect(isPublicPath("/api/v1/hermes/teste")).toBe(true);
    expect(isPublicPath("/api/v1/hermes/teste/x")).toBe(false);
  });
  it("CERCA: rota e módulo não ganham caminho de envio, passagem ou fila", () => {
    const raiz = process.cwd();
    for (const rel of ["app/api/v1/hermes/teste/route.ts", "lib/teste-do-hermes/teste-do-hermes.ts"]) {
      const src = readFileSync(path.join(raiz, rel), "utf8");
      for (const proibido of [/enqueueJob/, /performHumanHandoff/, /avisarLead/, /sendMessage\(/, /WahaChannelAdapter/, /emit_event/, /insert into (job_queue|event_log|cron_jobs|agent_cases|calendar_appointments)/i]) {
        expect(src, `${rel} não pode usar ${proibido}`).not.toMatch(proibido);
      }
    }
    const lib = readFileSync(path.join(raiz, "lib/teste-do-hermes/teste-do-hermes.ts"), "utf8");
    expect(lib).toMatch(/kind: 'assisted'/);
    expect(lib).toMatch(/'archived'/);
    expect(lib).toMatch(/historico_importado: 'true'/);
    expect(lib).not.toMatch(/is_personal\s*(=|,|\))/);
  });
});
