import { describe, expect, it, vi } from "vitest";
import {
  CABECALHO_DOS_RECADOS_ABERTOS,
  TETO_DO_TITULO_DO_RECADO,
  buildRecadosAbertosBlock,
  orgsDosRecadosAbertos,
  sondarEMissaoLigado,
  renderRecadosAbertos,
  semTelefone,
} from "@/lib/agent-engine/agent/abertura/recados-abertos";

const ORG = "4d9f40e1-e122-45a8-8693-7c3527d0fe78";
const CONTATO = "853b5f49-234f-4e74-9383-af055f816e1c";
const ligada = { SONDAR_E_MISSAO_ORGS: ORG } as unknown as NodeJS.ProcessEnv;
const AGORA = new Date("2026-11-26T12:00:00Z");

function dbFalso(respostas: Array<{ rows: unknown[] } | Error>) {
  const query = vi.fn(async () => {
    const r = respostas.shift();
    if (r instanceof Error) throw r;
    return r ?? { rows: [] };
  });
  return { query } as unknown as Parameters<typeof buildRecadosAbertosBlock>[0] & { query: typeof query };
}

const RECADO = {
  contato: "Calebe",
  criada_em: "2026-11-25T19:25:20Z",
  headline:
    'Recado do Lucas (25/11 às 15:25): aqui o Lucas é o cliente; você mandou "Oi, Calebe! O Fernando me passou seu contato."; assunto: Quem Somos e por Que Lutamos em versão digital',
};
const INDICACAO = { contato: "Fernando", criada_em: "2026-11-25T18:17:19Z", headline: "Fernando indicou Calebe PCO (41 9916-0641) para o livro digital" };

describe("opção por org", () => {
  it("lê a lista com vírgula, espaço ou ponto e vírgula, sem caixa", () => {
    expect(orgsDosRecadosAbertos(` ${ORG.toUpperCase()} ; outra,x `)).toEqual(new Set([ORG, "outra", "x"]));
    expect(orgsDosRecadosAbertos(undefined).size).toBe(0);
    expect(orgsDosRecadosAbertos("").size).toBe(0);
  });
  it("desligada por padrão", () => {
    expect(sondarEMissaoLigado(ORG, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(sondarEMissaoLigado(ORG, ligada)).toBe(true);
    expect(sondarEMissaoLigado("outra-org", ligada)).toBe(false);
  });
});

describe("telefone nunca entra no bloco", () => {
  it("mascara os formatos comuns e mantém preço e data", () => {
    expect(semTelefone("Calebe PCO (41) 99916-0641 e +55 11 97843-2684 e 41 9916-0641")).toBe(
      "Calebe PCO [telefone] e [telefone] e [telefone]",
    );
    expect(semTelefone("R$ 139,90 por mês; faz 3 em 04/03/2027; turma 2026")).toBe("R$ 139,90 por mês; faz 3 em 04/03/2027; turma 2026");
  });
});

describe("renderRecadosAbertos", () => {
  it("vazio sem linhas", () => {
    expect(renderRecadosAbertos([])).toBe("");
  });
  it("cabeçalho, data, contato e título, sem telefone, com teto", () => {
    const longo = { ...RECADO, headline: "Recado do Lucas: " + "x".repeat(400) };
    const bloco = renderRecadosAbertos([RECADO, INDICACAO, longo]);
    const linhas = bloco.split("\n");
    expect(linhas[0]).toBe(CABECALHO_DOS_RECADOS_ABERTOS);
    expect(linhas[1]).toContain("- 25/11, contato Calebe: Recado do Lucas (25/11 às 15:25)");
    expect(linhas[2]).toBe("- 25/11, contato Fernando: Fernando indicou Calebe PCO [telefone] para o livro digital");
    expect(bloco).not.toMatch(/\d{4}-\d{4}/);
    expect(linhas[3]!.length).toBeLessThan(TETO_DO_TITULO_DO_RECADO + 40);
    expect(linhas[3]!.endsWith("…")).toBe(true);
  });
});

describe("buildRecadosAbertosBlock", () => {
  it("opção desligada: '' sem consultar o banco (turno de sempre)", async () => {
    const db = dbFalso([]);
    expect(await buildRecadosAbertosBlock(db, ORG, CONTATO, AGORA, {} as NodeJS.ProcessEnv)).toBe("");
    expect(db.query).not.toHaveBeenCalled();
  });
  it("contato antigo ou já com recado: ''", async () => {
    expect(await buildRecadosAbertosBlock(dbFalso([{ rows: [{ novo: false, tem_recado: false }] }]), ORG, CONTATO, AGORA, ligada)).toBe("");
    expect(await buildRecadosAbertosBlock(dbFalso([{ rows: [{ novo: true, tem_recado: true }] }]), ORG, CONTATO, AGORA, ligada)).toBe("");
    expect(await buildRecadosAbertosBlock(dbFalso([{ rows: [] }]), ORG, CONTATO, AGORA, ligada)).toBe("");
  });
  it("contato novo: o bloco com os recados de outros contatos, 14 dias, até 6", async () => {
    const db = dbFalso([{ rows: [{ novo: true, tem_recado: false }] }, { rows: [RECADO, INDICACAO] }]);
    const bloco = await buildRecadosAbertosBlock(db, ORG, CONTATO, AGORA, ligada);
    expect(bloco.startsWith(CABECALHO_DOS_RECADOS_ABERTOS)).toBe(true);
    expect(bloco).toContain("contato Calebe");
    const [, segunda] = db.query.mock.calls as unknown as Array<[string, unknown[]]>;
    expect(segunda![0]).toContain("n.contact_id <> $2");
    expect(segunda![0]).toContain("is_merged_into is null");
    expect(segunda![1]).toEqual([ORG, CONTATO, "2026-11-12T12:00:00.000Z", 6]);
  });
  it("sem recado aberto: ''", async () => {
    expect(await buildRecadosAbertosBlock(dbFalso([{ rows: [{ novo: true, tem_recado: false }] }, { rows: [] }]), ORG, CONTATO, AGORA, ligada)).toBe("");
  });
  it("erro de leitura nunca derruba o turno", async () => {
    expect(await buildRecadosAbertosBlock(dbFalso([new Error("caiu")]), ORG, CONTATO, AGORA, ligada)).toBe("");
  });
});
