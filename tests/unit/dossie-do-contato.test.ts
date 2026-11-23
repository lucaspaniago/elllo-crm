import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CATEGORIAS_DO_DOSSIE,
  FONTES_DO_DOSSIE,
  LEGENDA_DO_DOSSIE,
  fonteDaEscritaDoAgente,
  trechosRepetidos,
  trechosReservados,
} from "@/lib/agent-engine/agent/dossie";
import { applySaveLeadNote, getLeadNoteBody, getLeadNotesIndex, renderNotesIndex } from "@/lib/agent-engine/agent/lead-notes";
import { BEFORE_SEND_GATES, notaDoLucasGate, type GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { aplicarCorrecao } from "@/lib/dossie/escrita-da-tela";

/**
 * O DOSSIÊ DO CONTATO (fork elllo, migration 9005) — o rapport que a Helô guarda de
 * cada pessoa em `lead_notes`, com categoria e fonte.
 *
 * O que este arquivo segura:
 *  1. o vocabulário do TypeScript é o mesmo das CHECKs da 9005;
 *  2. a FONTE é do código: o modelo não a manda, e o agente nunca grava `lucas`;
 *  3. o agente não apaga, por `supersedes`, a nota que o Lucas escreveu;
 *  4. a leitura é presa a (organização, contato): nota de um contato não entra no
 *     atendimento de outro;
 *  5. o que o Lucas contou não sai na resposta (cerca `nota_do_lucas`), a não ser o
 *     que a conversa já tem ou o que ele liberou;
 *  6. a tela mantém a fonte ao corrigir e só libera o que é do Lucas.
 */

const RAIZ = path.resolve(__dirname, "../..");
const MIGRATION = fs.readFileSync(
  path.join(RAIZ, "supabase/migrations/20261123190000_9005_dossie_do_contato.sql"),
  "utf8",
);

function valoresDaCheck(nome: string): string[] {
  const m = new RegExp(`${nome} in \\(([^)]*)\\)`).exec(MIGRATION);
  if (!m) throw new Error(`CHECK de ${nome} não achada na 9005`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

type Chamada = { text: string; values: unknown[] };
function dbFalso(linhas: Array<Record<string, unknown>> = []) {
  const chamadas: Chamada[] = [];
  return {
    chamadas,
    query: async (text: string, values: unknown[] = []) => {
      chamadas.push({ text, values });
      if (/^\s*select id, headline/.test(text)) return { rows: linhas, rowCount: linhas.length };
      if (/select body from lead_notes/.test(text)) return { rows: [], rowCount: 0 };
      return { rows: [{ id: "nova", superseded: "0" }], rowCount: 1 };
    },
  } as never as { chamadas: Chamada[]; query: (t: string, v?: unknown[]) => Promise<{ rows: never[] }> };
}

describe("o vocabulário do dossiê é o mesmo do banco (9005)", () => {
  it("categorias e fontes batem com as CHECKs", () => {
    expect(valoresDaCheck("categoria")).toEqual([...CATEGORIAS_DO_DOSSIE]);
    expect(valoresDaCheck("fonte")).toEqual([...FONTES_DO_DOSSIE]);
  });
  it("o default da fonte é lucas, a mais restrita", () => {
    expect(MIGRATION).toMatch(/add column fonte text not null default 'lucas'/);
  });
});

describe("a fonte é do código, nunca do modelo", () => {
  it("o agente grava pessoa, e helo só em jeito e tom", () => {
    for (const c of CATEGORIAS_DO_DOSSIE) {
      expect(fonteDaEscritaDoAgente(c)).toBe(c === "jeito" || c === "tom" ? "helo" : "pessoa");
    }
  });

  it("um `fonte` no payload do save_lead_note é erro de ensino e nada é gravado", async () => {
    const db = dbFalso();
    const r = await applySaveLeadNote(db as never, { tenantId: "org-a", leadId: "c-1" }, { budgetTokens: 5000 }, {
      headline: "gosta de pizza",
      body: "contou que pede pizza toda sexta",
      categoria: "gostos",
      fonte: "lucas",
    });
    expect(r.ok).toBe(false);
    expect(db.chamadas.some((c) => /insert into lead_notes/.test(c.text))).toBe(false);
  });

  it("a nota do agente leva a categoria e a fonte do código no insert", async () => {
    const db = dbFalso();
    const r = await applySaveLeadNote(db as never, { tenantId: "org-a", leadId: "c-1" }, { budgetTokens: 5000 }, {
      headline: "prefere áudio curto",
      body: "disse que não lê texto longo",
      categoria: "jeito",
    });
    expect(r.ok).toBe(true);
    const insert = db.chamadas.find((c) => /insert into lead_notes/.test(c.text))!;
    expect(insert.text).toMatch(/headline, body, categoria, fonte/);
    expect(insert.values.slice(5)).toEqual(["jeito", "helo"]);
  });

  it("sem categoria, vira fato contado pela pessoa", async () => {
    const db = dbFalso();
    await applySaveLeadNote(db as never, { tenantId: "org-a", leadId: "c-1" }, { budgetTokens: 5000 }, {
      headline: "tem 2 unidades",
      body: "academia com duas unidades em Campo Grande",
    });
    const insert = db.chamadas.find((c) => /insert into lead_notes/.test(c.text))!;
    expect(insert.values.slice(5)).toEqual(["fato", "pessoa"]);
  });

  it("o agente não apaga por supersedes a nota que o Lucas escreveu", async () => {
    const db = dbFalso([
      { id: "11111111-1111-1111-1111-111111111111", headline: "recado", categoria: "pendente", fonte: "lucas", liberada: false },
      { id: "22222222-2222-2222-2222-222222222222", headline: "gosta de pizza", categoria: "gostos", fonte: "pessoa", liberada: false },
    ]);
    await applySaveLeadNote(db as never, { tenantId: "org-a", leadId: "c-1" }, { budgetTokens: 5000 }, {
      headline: "resumo",
      body: "tudo junto",
      supersedes: ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"],
    });
    const insert = db.chamadas.find((c) => /insert into lead_notes/.test(c.text))!;
    expect(insert.values[2]).toEqual(["22222222-2222-2222-2222-222222222222"]);
  });
});

describe("nota de um contato não entra no atendimento de outro", () => {
  it("o índice e o corpo são lidos por (organização, contato) do runtime", async () => {
    const db = dbFalso();
    await getLeadNotesIndex(db as never, "org-a", "contato-a");
    await getLeadNoteBody(db as never, "org-a", "contato-a", "nota-do-b");
    for (const c of db.chamadas) {
      expect(c.text).toMatch(/where organization_id = \$1 and contact_id = \$2/);
      expect(c.values.slice(0, 2)).toEqual(["org-a", "contato-a"]);
    }
  });

  it("o recall híbrido, o contexto do atendimento e o rascunho filtram pelos dois", () => {
    const arquivos = [
      "lib/agent-engine/agent/lead-notes-recall.ts",
      "lib/agent-engine/agent/contexto-do-atendimento.ts",
      "lib/agent-engine/agent/reply-drafts.ts",
    ];
    for (const a of arquivos) {
      const src = fs.readFileSync(path.join(RAIZ, a), "utf8");
      const leituras = [...src.matchAll(/from lead_notes[\s\S]{0,120}?where([^`"]*)/g)].map((m) => m[1]!);
      expect(leituras.length, a).toBeGreaterThan(0);
      for (const w of leituras) expect(w, a).toMatch(/organization_id\s*=\s*\$1\s+and\s+contact_id\s*=\s*\$2/);
    }
  });

  it("o resumo do atendimento fechado lê só a conversa daquele contato", () => {
    const src = fs.readFileSync(path.join(RAIZ, "lib/agent-engine/agent/dossie-ao-fechar.ts"), "utf8");
    expect(src).toMatch(/where m\.organization_id = \$1 and m\.conversation_id = \$2 and m\.contact_id = \$3/);
  });

  it("a leitura de rapport do mensageiro é só do servidor e não traz conversa", () => {
    expect(MIGRATION).toMatch(/revoke all on function public\.fn_rapport_do_contato\(uuid, uuid, text\) from public, anon, authenticated/);
    const corpo = MIGRATION.slice(MIGRATION.indexOf("create or replace function public.fn_rapport_do_contato"));
    expect(corpo).not.toMatch(/public\.messages/);
    expect(corpo).toMatch(/n\.organization_id = p_organization_id/);
    expect(corpo).toMatch(/not like 'Recado do Lucas%'/);
  });
});

describe("o índice diz do que a nota fala e quem contou", () => {
  it("a nota do Lucas sai marcada como só para a Helô, com a legenda", () => {
    const txt = renderNotesIndex([
      { id: "n1", headline: "teve bebê", categoria: "fato", fonte: "lucas", liberada: false },
      { id: "n2", headline: "gosta de pilates", categoria: "gostos", fonte: "pessoa", liberada: false },
      { id: "n3", headline: "pode falar do evento", categoria: "pendente", fonte: "lucas", liberada: true },
    ]);
    expect(txt.startsWith(LEGENDA_DO_DOSSIE)).toBe(true);
    expect(txt).toMatch(/\[n1\] \(fato · contou o Lucas; só para você, não repita a ela\) teve bebê/);
    expect(txt).toMatch(/\[n2\] \(gostos · contou a pessoa\) gosta de pilates/);
    expect(txt).toMatch(/\[n3\] \(pendente · contou o Lucas; pode usar com ela\)/);
  });
  it("sem as colunas (leitura antiga), o índice sai como antes", () => {
    expect(renderNotesIndex([{ id: "x", headline: "h" }])).toBe("- [x] h");
  });
});

describe("o que o Lucas contou não vai ao contato (cerca nota_do_lucas)", () => {
  const notaDoLucas = {
    headline: "Família",
    body: "A Flávia acabou de ter um bebê e está de licença até março",
    fonte: "lucas",
    liberada: false,
  };

  it("repetir o trecho da nota é barrado", () => {
    const r = trechosReservados([notaDoLucas], ["Oi Flávia, tudo bem?"]);
    expect(trechosRepetidos("Parabéns! Soube que a Flávia acabou de ter um bebê", r)).toBeGreaterThan(0);
  });
  it("o que a conversa já tem não é segredo", () => {
    const r = trechosReservados([notaDoLucas], ["Eu acabei de ter um bebê, por isso a Flávia está de licença até março"]);
    expect(trechosRepetidos("Entendi, então a Flávia está de licença até março", r)).toBe(0);
  });
  it("nota liberada, ou contada pela pessoa, não arma a cerca", () => {
    expect(trechosReservados([{ ...notaDoLucas, liberada: true }], []).size).toBe(0);
    expect(trechosReservados([{ ...notaDoLucas, fonte: "pessoa" }], []).size).toBe(0);
  });
  it("trecho só de palavras vazias não conta", () => {
    const r = trechosReservados([{ ...notaDoLucas, body: "o Lucas pediu que você me ajude" }], []);
    expect(trechosRepetidos("O Lucas pediu que você me ajude aqui", r)).toBe(0);
  });

  const ctx = (body: string, trechos: Set<string>) => ({ body, trechosDoLucas: trechos }) as unknown as GateContext;
  it("o gate veta com código e sem o texto no detalhe", () => {
    const r = trechosReservados([notaDoLucas], []);
    const v = notaDoLucasGate.evaluate(ctx("a Flávia acabou de ter um bebê, né?", r));
    expect(v).toMatchObject({ pass: false, code: "nota_do_lucas_repetida" });
    expect(JSON.stringify((v as { detail?: unknown }).detail)).not.toMatch(/bebê|bebe|Flávia/i);
  });
  it("sem trechos, passa", () => {
    expect(notaDoLucasGate.evaluate(ctx("qualquer coisa", new Set()))).toEqual({ pass: true });
  });
  it("vem logo depois do vocabulário interno, antes de o disclosure emendar o corpo", () => {
    const nomes = BEFORE_SEND_GATES.map((g) => g.name);
    expect(nomes.indexOf("nota_do_lucas")).toBe(nomes.indexOf("internal_vocabulary") + 1);
    expect(nomes.indexOf("nota_do_lucas")).toBeLessThan(nomes.indexOf("disclosure"));
  });
});

describe("a tela corrige sem mudar quem contou", () => {
  it("corrigir o texto mantém a fonte e zera o embedding", () => {
    const r = aplicarCorrecao({ categoria: "gostos", fonte: "pessoa", liberada: false }, { body: "gosta de pilates e yoga" });
    expect(r).toMatchObject({ ok: true, valores: { fonte: "pessoa", categoria: "gostos", embedding: null } });
  });
  it("observação da Helô mudada para outra categoria passa a ser do Lucas", () => {
    const r = aplicarCorrecao({ categoria: "jeito", fonte: "helo", liberada: false }, { categoria: "rotina" });
    expect(r).toMatchObject({ ok: true, valores: { fonte: "lucas" } });
  });
  it("só o que o Lucas contou pode ser liberado", () => {
    expect(aplicarCorrecao({ categoria: "fato", fonte: "pessoa", liberada: false }, { liberada: true })).toEqual({
      ok: false,
      motivo: "liberada_so_do_lucas",
    });
    expect(aplicarCorrecao({ categoria: "fato", fonte: "lucas", liberada: false }, { liberada: true })).toMatchObject({
      ok: true,
      valores: { liberada: true },
    });
  });
});
