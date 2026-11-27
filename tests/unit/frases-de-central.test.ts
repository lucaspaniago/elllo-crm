/**
 * Fork elllo (voz1, 26/11/2026): as frases fixas que o código ensina à Helô do CRM, ou que
 * ela usa depois de um veto, não podem soar central de atendimento ("helo-voz-fluida").
 * Este teste QUEBRA se uma delas voltar a ter uma frase proibida.
 */
import { describe, expect, it } from "vitest";
import { FRASE_DA_HELO_EM_PEDIDO_SOBRE_CASO_ABERTO, recusaDeCasoAberto } from "@/lib/agent-engine/agent/human-cases";
import { ENSINO_DA_NOTA_DO_LUCAS } from "@/lib/agent-engine/agent/dossie";
import { instrucaoDoCasoConcluido } from "@/lib/agent-engine/agent/case-reply-turn";

export const FRASES_PROIBIDAS = [
  /uma posi[çc][ãa]o do lucas/i, /\banotado\b/i, /\banotei\b/i, /agradece (a sua|pela|a) aten[çc][ãa]o/i,
  /pra eu passar certinho/i, /seguir com a compra/i, /me retornou/i, /obrigada por me passar tudo/i,
  /assim que eu tiver/i, /fico no aguardo/i, /ficou registrad/i, /te responde por aqui/i,
];
const falada = (t: string) => FRASES_PROIBIDAS.filter((r) => r.test(t)).map(String);

describe("frases fixas da Helô sem cara de central (voz1)", () => {
  it("a frase de caso aberto, na voz da Helô", () => {
    expect(falada(FRASE_DA_HELO_EM_PEDIDO_SOBRE_CASO_ABERTO)).toEqual([]);
    expect(FRASE_DA_HELO_EM_PEDIDO_SOBRE_CASO_ABERTO).not.toMatch(/Lucas/);
    const r = recusaDeCasoAberto(true);
    expect(r.ok ? "" : falada(r.error.message).join()).toBe("");
  });
  it("o ensino da cerca nota_do_lucas pede a mesma conversa, não a frase genérica", () => {
    expect(ENSINO_DA_NOTA_DO_LUCAS).toMatch(/mesmo calor/);
    expect(ENSINO_DA_NOTA_DO_LUCAS).toMatch(/frase gen[ée]rica/);
  });
  it("a resposta do Lucas a um caso: com as palavras dela e cobrindo o que estava em aberto", () => {
    const t = instrucaoDoCasoConcluido("9242eeaa", "fala que eu ja tenho a versao impressa, mas agradeço a atenção", true);
    expect(t).toMatch(/suas palavras/);
    expect(t).toMatch(/tudo o que estava em aberto/);
    expect(t).not.toMatch(/encerre o assunto/);
  });
  it("opção desligada: a instrução de sempre, byte a byte", () => {
    expect(instrucaoDoCasoConcluido("abc12345", "ok", false)).toBe(
      'O responsável concluiu o caso #abc12345 com a nota: "ok". Repasse essa conclusão ao lead de forma natural e encerre o assunto.');
  });
  it("o próprio teste pega a frase de central", () => {
    expect(falada("Calebe, o Lucas me retornou: não vai seguir com a compra, mas agradece a sua atenção.")).toHaveLength(3);
    expect(falada("Bom dia, Calebe! Assim que eu tiver uma posição do Lucas, te falo por aqui.")).toHaveLength(2);
  });
});
