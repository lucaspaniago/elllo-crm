/**
 * Fork elllo (acervo1, migration 9006): o ACERVO de peças pelo mensageiro do Hermes.
 * Prova as regras puras (janela da reserva, código, espelho no catálogo, conferência da
 * foto), que a chave vazia desliga, e (cerca) que o vocabulário do TypeScript é o mesmo das
 * CHECKs da 9006 e que a rota segue o molde das rotas por token.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  acervoLigado,
  dataValida,
  diaUtil,
  espelhoNoCatalogo,
  formatarCodigo,
  hojeNoFuso,
  janelaDaReserva,
  limparTexto,
  normalizarCodigo,
  somarDias,
  STATUS,
  USOS,
} from "@/lib/acervo/acervo";
import { conferirFoto, dimensoesDaImagem, FOTO_BYTES_MAXIMO } from "@/lib/acervo/fotos-do-acervo";

const RAIZ = process.cwd();
const ORG = "a1b2c3d4-0000-4000-8000-000000000001";
const env = (v: string) => ({ ACERVO_ORGS: v }) as unknown as NodeJS.ProcessEnv;
const FUSO = "America/Campo_Grande";

function png(largura: number, altura: number, tamanho = 64): Uint8Array {
  const b = new Uint8Array(tamanho);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, largura);
  new DataView(b.buffer).setUint32(20, altura);
  return b;
}
function jpeg(largura: number, altura: number, tamanho = 64): Uint8Array {
  const b = new Uint8Array(tamanho);
  // SOI, APP0 de 16 bytes, depois SOF0 com altura e largura.
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const sof = 2 + 2 + 16;
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08], sof);
  new DataView(b.buffer).setUint16(sof + 5, altura);
  new DataView(b.buffer).setUint16(sof + 7, largura);
  return b;
}

describe("acervo: a chave", () => {
  it("vazia = desligado; liga só a organização listada", () => {
    expect(acervoLigado(ORG, env(""))).toBe(false);
    expect(acervoLigado(ORG, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(acervoLigado(ORG, env(` x, ${ORG.toUpperCase()} `))).toBe(true);
    expect(acervoLigado("ffffffff-0000-4000-8000-000000000002", env(ORG))).toBe(false);
    expect(acervoLigado(null, env(ORG))).toBe(false);
  });
});

describe("acervo: a janela da reserva", () => {
  it("retirada 1 dia antes; devolução no dia útil seguinte", () => {
    // quarta 2027-03-10 → quinta
    expect(janelaDaReserva("2027-03-10", FUSO)).toEqual({ retirada: "2027-03-09", devolucao: "2027-03-11" });
    // sexta → segunda; sábado → segunda; domingo → segunda
    expect(janelaDaReserva("2027-03-12", FUSO).devolucao).toBe("2027-03-15");
    expect(janelaDaReserva("2027-03-13", FUSO)).toEqual({ retirada: "2027-03-12", devolucao: "2027-03-15" });
    expect(janelaDaReserva("2027-03-14", FUSO).devolucao).toBe("2027-03-15");
  });
  it("pula feriado nacional (Natal numa sexta de 2026 → segunda 28)", () => {
    expect(diaUtil("2026-12-25", FUSO)).toBe(false);
    expect(janelaDaReserva("2026-12-24", FUSO)).toEqual({ retirada: "2026-12-23", devolucao: "2026-12-28" });
    // Tiradentes 2027 é quarta: evento na terça 20 devolve na quinta 22.
    expect(janelaDaReserva("2027-04-20", FUSO).devolucao).toBe("2027-04-22");
  });
  it("datas: forma, soma e hoje no fuso", () => {
    expect(dataValida("2027-02-29")).toBe(false);
    expect(dataValida("2028-02-29")).toBe(true);
    expect(dataValida("27-01-01")).toBe(false);
    expect(somarDias("2026-12-31", 1)).toBe("2027-01-01");
    expect(somarDias("2027-03-01", -1)).toBe("2027-02-28");
    // 02:30 UTC do dia 27 ainda é dia 26 em Campo Grande (UTC-4).
    expect(hojeNoFuso(new Date("2026-11-27T02:30:00Z"), FUSO)).toBe("2026-11-26");
    expect(hojeNoFuso(new Date("2026-11-27T02:30:00Z"), "fuso/invalido")).toBe("2026-11-26");
  });
});

describe("acervo: código, textos e espelho no catálogo", () => {
  it("código sugerido e normalizado", () => {
    expect(formatarCodigo(1)).toBe("A-0001");
    expect(formatarCodigo(12345)).toBe("A-12345");
    expect(normalizarCodigo(" vl-042 ")).toBe("VL-042");
    expect(normalizarCodigo("com espaço")).toBeNull();
    expect(normalizarCodigo("")).toBeNull();
    expect(limparTexto("  Vestido   Lírio ")).toBe("Vestido Lírio");
    expect(limparTexto("   ")).toBeNull();
  });
  it("o espelho usa o preço da locação em 'ambos' e mostra os dois na descrição", () => {
    const e = espelhoNoCatalogo({ modelo: "Lírio", cor: "Azul", tamanho: "42", uso: "ambos", preco_venda_centavos: 120000, preco_locacao_centavos: 35000, descricao: "Longo, com renda." });
    expect(e.nome).toBe("Lírio · Azul · tam. 42");
    expect(e.preco_cents).toBe(35000);
    expect(e.descricao).toBe("Longo, com renda.\nVenda: R$ 1.200,00 · Locação: R$ 350,00");
    expect(espelhoNoCatalogo({ modelo: "M", cor: "C", tamanho: "P", uso: "venda", preco_venda_centavos: 9990, preco_locacao_centavos: null, descricao: null }).preco_cents).toBe(9990);
  });
});

describe("acervo: a foto é conferida, não reduzida", () => {
  it("lê as dimensões do PNG e do JPEG pelo cabeçalho", () => {
    expect(dimensoesDaImagem(png(1600, 1200), "image/png")).toEqual({ largura: 1600, altura: 1200 });
    expect(dimensoesDaImagem(jpeg(1200, 1600), "image/jpeg")).toEqual({ largura: 1200, altura: 1600 });
  });
  it("aceita até 1600 px e 800 KB; recusa o resto com o motivo", () => {
    expect(conferirFoto(png(1600, 900))).toMatchObject({ ok: true, tipo: "image/png" });
    expect(conferirFoto(jpeg(1080, 1440))).toMatchObject({ ok: true, tipo: "image/jpeg" });
    expect(conferirFoto(png(1601, 900))).toMatchObject({ ok: false, erro: "foto_grande" });
    expect(conferirFoto(jpeg(900, 2000))).toMatchObject({ ok: false, erro: "foto_grande" });
    expect(conferirFoto(png(800, 600, FOTO_BYTES_MAXIMO + 1))).toMatchObject({ ok: false, erro: "foto_grande" });
    expect(conferirFoto(new TextEncoder().encode("<svg></svg>"))).toMatchObject({ ok: false, erro: "foto_invalida" });
    expect(conferirFoto(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toMatchObject({ ok: false, erro: "foto_invalida" });
  });
});

describe("CERCA: o banco e a rota", () => {
  const migracao = readdirSync(path.join(RAIZ, "supabase/migrations")).find((n) => /_9006_acervo/.test(n));
  const sql = readFileSync(path.join(RAIZ, "supabase/migrations", migracao ?? "inexistente"), "utf8");
  const baseline = readFileSync(path.join(RAIZ, "supabase/baseline.sql"), "utf8");

  it("o vocabulário de uso e status é o mesmo das CHECKs da 9006", () => {
    const lista = (nome: string) => {
      const m = sql.match(new RegExp(`${nome}_check\\s*\\n\\s*check \\(\\w+ in \\(([^)]*)\\)\\)`));
      return (m?.[1] ?? "").split(",").map((s) => s.trim().replace(/'/g, ""));
    };
    expect(lista("acervo_pecas_uso")).toEqual([...USOS]);
    expect(lista("acervo_pecas_status")).toEqual([...STATUS]);
  });
  it("as tabelas são só do servidor (RLS ligada, nada para anon/authenticated), no baseline também", () => {
    for (const t of ["acervo_pecas", "acervo_status_historico", "acervo_reservas", "acervo_previas"]) {
      for (const fonte of [sql, baseline]) {
        expect(fonte).toContain(`alter table public.${t} enable row level security;`);
        expect(fonte).toContain(`revoke all on public.${t} from anon, authenticated;`);
      }
      expect(sql).not.toMatch(new RegExp(`grant[^;]*on public\\.${t} to [^;]*(anon|authenticated)`));
    }
  });
  it("a rota só aceita token, confere a chave e não manda mensagem", () => {
    const rota = readFileSync(path.join(RAIZ, "app/api/v1/acervo/route.ts"), "utf8");
    expect(rota).toMatch(/authz\.via !== "token"\) return erro\("so_token", 403/);
    expect(rota).toMatch(/if \(!acervoLigado\(organizationId\)\) return erro\("acervo_desligado", 404/);
    expect(rota).not.toMatch(/send(Message|Text|Media)|enqueue|waha/i);
    const modulo = readFileSync(path.join(RAIZ, "lib/acervo/acervo.ts"), "utf8");
    expect(modulo).not.toMatch(/send(Message|Text|Media)|enqueue|waha/i);
  });
});
