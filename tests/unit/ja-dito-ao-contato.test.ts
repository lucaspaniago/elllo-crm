import { describe, expect, it } from "vitest";
import { jaDitoAoContato, TETO_DO_JA_DITO } from "@/lib/agent-engine/agent/ja-dito-ao-contato";
import { trechosReservados, trechosRepetidos } from "@/lib/agent-engine/agent/dossie";

const RECADO = {
  headline: "Recado do Lucas (25/11 às 15:25): você mandou \"Oi, Calebe! Você sabe se o livro Quem Somos e por Que Lutamos existe em versão digital?\"",
  body: "Assunto: Verificar se Quem Somos e por Que Lutamos existe em versão digital.",
  fonte: "lucas",
  liberada: false,
};
const ENVIADO = "Oi, Calebe! O Fernando me passou seu contato. Você sabe se o livro Quem Somos e por Que Lutamos existe em versão digital e se é possível comprá-la?";
const RESPOSTA = "Bom dia! E o Quem Somos e por Que Lutamos, tem em versão digital?";

describe("o que já foi dito ao contato (voz1)", () => {
  it("recado mandado em OUTRA conversa: sem ele na conta a cerca veta; com ele, passa", () => {
    const soHistorico = trechosReservados([RECADO], ["Bom dia"]);
    expect(trechosRepetidos(RESPOSTA, soHistorico)).toBeGreaterThan(0);
    const comJaDito = trechosReservados([RECADO], ["Bom dia", ENVIADO]);
    expect(trechosRepetidos(RESPOSTA, comJaDito)).toBe(0);
  });

  it("o que nunca saiu continua reservado", () => {
    const nota = { headline: "Lucas contou", body: "ele está passando por um divórcio difícil este ano", fonte: "lucas", liberada: false };
    const r = trechosReservados([nota], [ENVIADO]);
    expect(trechosRepetidos("Soube que você está passando por um divórcio difícil este ano", r)).toBeGreaterThan(0);
  });

  it("lê o contato e os juntados a ele, com teto, e devolve os textos", async () => {
    const chamadas: Array<{ sql: string; params: unknown[] }> = [];
    const db = { query: async (sql: string, params: unknown[]) => { chamadas.push({ sql, params }); return { rows: [{ body: ENVIADO }], rowCount: 1 }; } };
    const r = await jaDitoAoContato(db as never, "org", "contato");
    expect(r).toEqual([ENVIADO]);
    expect(chamadas[0]!.sql).toMatch(/is_merged_into = \$2/);
    expect(chamadas[0]!.params).toEqual(["org", "contato", TETO_DO_JA_DITO]);
  });

  it("erro de leitura: lista vazia (a cerca fica mais rígida, nunca mais frouxa)", async () => {
    const db = { query: async () => { throw new Error("caiu"); } };
    expect(await jaDitoAoContato(db as never, "org", "contato")).toEqual([]);
  });
});
