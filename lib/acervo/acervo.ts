/**
 * O ACERVO — peças físicas de uma loja de aluguel e venda (fork elllo, acervo1, migration 9006).
 *
 * Pedido do dono para a instalação de uma loja (Martinica): o mensageiro do Hermes cadastra,
 * publica, muda o status e reserva peças pelo CRM, SEMPRE em dois passos:
 *
 *  1. **prévia** — confere tudo e devolve o que vai ser gravado, com um `id_previa` que vale
 *     30 minutos. Não toca no acervo (só guarda a própria prévia e, no cadastro, as fotos
 *     num caminho que só vira do produto se a prévia for gravada).
 *  2. **gravar** — recebe SÓ o `id_previa` e grava exatamente o que a prévia mostrou, uma vez
 *     só (a segunda chamada devolve o mesmo resultado com `repetido: true`). Se algo mudou
 *     desde a prévia (o código foi tomado, o status já é outro, a data foi reservada), recusa
 *     com `mudou_desde_a_previa` e nada é gravado. O "sim" da pessoa acontece do lado do Hermes.
 *
 * ## A peça
 *
 * Um código por peça física (sugerido: `A-0001`, `A-0002`…), modelo, cor e tamanho (o grupo),
 * uso (venda, locação ou ambos), preço de venda e de locação em centavos, descrição curta,
 * observações e até 5 fotos. Nasce `disponivel` e NÃO publicada (o site lê só as publicadas).
 * Mesmo modelo, cor e tamanho de outra peça = aviso na prévia, nunca recusa (são peças iguais).
 *
 * A peça é espelhada em `catalog_products` (mesmo id, `origem = 'acervo'`, que o painel abre
 * só para leitura): `ativo` = publicada, `quantidade` = 1 só quando disponível, e as fotos
 * moram lá (bucket `catalog-photos`, caminho `<org>/<id da peça>/<uuid>.jpg`).
 *
 * ## Status e reservas
 *
 * disponivel, reservada, alugada, na_costureira, na_lavanderia, vendida. Cada troca grava o
 * histórico; entrar em `alugada` soma 1 em `vezes_alugada`; `vendida` despublica.
 * A reserva é por data de evento: retirada 1 dia antes, devolução no primeiro dia útil depois
 * (sem sábado, domingo e feriado nacional, no fuso da organização). Duas reservas da mesma
 * peça não podem se encostar (o intervalo [retirada, devolução] é fechado dos dois lados).
 * A consulta de disponibilidade só lê.
 *
 * ## A chave
 *
 * `ACERVO_ORGS` — uuids das organizações em que a rota `/api/v1/acervo` responde. Vazia (o
 * padrão) = rota desligada (404) e nada muda. Nada aqui manda mensagem a ninguém.
 */
import { randomUUID } from "node:crypto";
import type pg from "pg";

import { ehFeriadoNacionalNoFuso } from "@/lib/agent-engine/agent/feriado-nacional";
import { fusoDaOrganizacao } from "@/lib/agent-engine/agent/fuso-da-org";
import { extensaoDe } from "@/lib/branding/logo-arquivo";

import { conferirFoto, FOTOS_POR_PECA } from "./fotos-do-acervo";

type Db = Pick<pg.Pool, "query" | "connect">;
type Consulta = Pick<pg.Pool, "query">;

export const USOS = ["venda", "locacao", "ambos"] as const;
export const STATUS = ["disponivel", "reservada", "alugada", "na_costureira", "na_lavanderia", "vendida"] as const;
export type Uso = (typeof USOS)[number];
export type Status = (typeof STATUS)[number];
export const VALIDADE_DA_PREVIA_MINUTOS = 30;
const FUSO_PADRAO = "America/Sao_Paulo";

export function acervoLigado(orgId: string | null | undefined, fonte: NodeJS.ProcessEnv = process.env): boolean {
  if (!orgId) return false;
  return (fonte.ACERVO_ORGS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "")
    .includes(orgId.trim().toLowerCase());
}

/** Onde as fotos moram. A rota usa o Storage; o teste, um armazém de mentira. */
export interface Armazem {
  subir(caminho: string, bytes: Uint8Array, tipo: string): Promise<boolean>;
  apagar(caminhos: string[]): Promise<void>;
}

export type Falha = { ok: false; erro: string; status: number; detalhe?: string; extra?: Record<string, unknown> };
const falha = (erro: string, status: number, detalhe?: string, extra?: Record<string, unknown>): Falha => ({ ok: false, erro, status, detalhe, extra });

// ── textos e datas ───────────────────────────────────────────────────────────

export function limparTexto(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
}

const FORMA_DO_CODIGO = /^[A-Z0-9][A-Z0-9._-]{0,39}$/;
export function normalizarCodigo(s: string): string | null {
  const c = s.trim().toUpperCase();
  return FORMA_DO_CODIGO.test(c) ? c : null;
}

export function formatarCodigo(n: number): string {
  return `A-${String(n).padStart(4, "0")}`;
}

export function dataValida(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

export function somarDias(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** O dia é útil? Sem sábado, domingo e feriado nacional (no fuso da organização). */
export function diaUtil(iso: string, fuso: string): boolean {
  const semana = new Date(`${iso}T00:00:00Z`).getUTCDay();
  if (semana === 0 || semana === 6) return false;
  // 15h UTC cai no mesmo dia civil em todo fuso do Brasil.
  return !ehFeriadoNacionalNoFuso(new Date(`${iso}T15:00:00Z`), fuso);
}

/** Retirada 1 dia antes do evento; devolução no primeiro dia útil depois dele. */
export function janelaDaReserva(dataEvento: string, fuso: string): { retirada: string; devolucao: string } {
  let devolucao = somarDias(dataEvento, 1);
  for (let i = 0; i < 15 && !diaUtil(devolucao, fuso); i++) devolucao = somarDias(devolucao, 1);
  return { retirada: somarDias(dataEvento, -1), devolucao };
}

export function hojeNoFuso(agora: Date, fuso: string): string {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(agora);
  try {
    return fmt(fuso);
  } catch {
    return fmt(FUSO_PADRAO);
  }
}

function reais(centavos: number): string {
  const inteiro = Math.floor(centavos / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `R$ ${inteiro},${String(centavos % 100).padStart(2, "0")}`;
}

// ── a peça ───────────────────────────────────────────────────────────────────

export interface Peca {
  codigo: string;
  modelo: string;
  cor: string;
  tamanho: string;
  uso: Uso;
  preco_venda_centavos: number | null;
  preco_locacao_centavos: number | null;
  descricao: string | null;
  observacoes: string | null;
  status: Status;
  publicada: boolean;
  vezes_alugada: number;
  fotos: number;
}

type LinhaDaPeca = Record<string, unknown> & { id: string };

const SELECT_PECA = `select ap.id, ap.codigo, ap.modelo, ap.cor, ap.tamanho, ap.uso,
       ap.preco_venda_cents::text as preco_venda_cents, ap.preco_locacao_cents::text as preco_locacao_cents,
       ap.descricao, ap.observacoes, ap.status, ap.publicada, ap.vezes_alugada,
       coalesce(cardinality(cp.fotos), 0) as n_fotos
  from public.acervo_pecas ap
  join public.catalog_products cp on cp.organization_id = ap.organization_id and cp.id = ap.id`;

const numeroOuNulo = (v: unknown): number | null => (v == null ? null : Number(v));

function pecaDaLinha(l: LinhaDaPeca): Peca {
  return {
    codigo: String(l.codigo),
    modelo: String(l.modelo),
    cor: String(l.cor),
    tamanho: String(l.tamanho),
    uso: l.uso as Uso,
    preco_venda_centavos: numeroOuNulo(l.preco_venda_cents),
    preco_locacao_centavos: numeroOuNulo(l.preco_locacao_cents),
    descricao: (l.descricao as string | null) ?? null,
    observacoes: (l.observacoes as string | null) ?? null,
    status: l.status as Status,
    publicada: l.publicada === true,
    vezes_alugada: Number(l.vezes_alugada ?? 0),
    fotos: Number(l.n_fotos ?? 0),
  };
}

async function pecaPorCodigo(db: Consulta, org: string, codigo: string, trava = false): Promise<LinhaDaPeca | null> {
  const { rows } = await db.query(
    `${SELECT_PECA} where ap.organization_id = $1 and ap.codigo = $2${trava ? " for update of ap" : ""}`,
    [org, codigo],
  );
  return (rows[0] as LinhaDaPeca | undefined) ?? null;
}

async function pecaPorId(db: Consulta, org: string, id: string, trava = false): Promise<LinhaDaPeca | null> {
  const { rows } = await db.query(
    `${SELECT_PECA} where ap.organization_id = $1 and ap.id = $2${trava ? " for update of ap" : ""}`,
    [org, id],
  );
  return (rows[0] as LinhaDaPeca | undefined) ?? null;
}

/** O nome, a descrição e o preço que o espelho em `catalog_products` mostra. */
export function espelhoNoCatalogo(p: Pick<Peca, "modelo" | "cor" | "tamanho" | "uso" | "preco_venda_centavos" | "preco_locacao_centavos" | "descricao">) {
  const precos = [
    p.preco_venda_centavos != null ? `Venda: ${reais(p.preco_venda_centavos)}` : null,
    p.preco_locacao_centavos != null ? `Locação: ${reais(p.preco_locacao_centavos)}` : null,
  ].filter(Boolean).join(" · ");
  return {
    nome: `${p.modelo} · ${p.cor} · tam. ${p.tamanho}`.slice(0, 200),
    descricao: [p.descricao, precos].filter(Boolean).join("\n"),
    // Locação é o principal da loja: em "ambos" o preço do catálogo é o da locação.
    preco_cents: p.uso === "venda" ? (p.preco_venda_centavos ?? 0) : (p.preco_locacao_centavos ?? 0),
  };
}

// ── as prévias ───────────────────────────────────────────────────────────────

type AcaoDaPrevia = "cadastro" | "publicar" | "status" | "reserva" | "cancelar_reserva";
export type Previa = { ok: true; id_previa: string; expira_em: string; vai_gravar: Record<string, unknown>; [k: string]: unknown };

async function guardarPrevia(db: Consulta, org: string, acao: AcaoDaPrevia, dados: Record<string, unknown>, fotos: string[], tokenId: string | null) {
  const { rows } = await db.query(
    `insert into public.acervo_previas (organization_id, acao, dados, fotos, api_token_id, expira_em)
     values ($1, $2, $3::jsonb, $4::text[], $5, now() + make_interval(mins => $6))
     returning id, expira_em`,
    [org, acao, JSON.stringify(dados), fotos, tokenId, VALIDADE_DA_PREVIA_MINUTOS],
  );
  const r = rows[0] as { id: string; expira_em: Date | string };
  return { id_previa: r.id, expira_em: new Date(r.expira_em).toISOString() };
}

/** Apaga as prévias vencidas que nunca foram gravadas, e as fotos que elas subiram. */
export async function limparPreviasVencidas(db: Consulta, armazem: Armazem, org: string): Promise<number> {
  const { rows } = await db.query(
    `delete from public.acervo_previas
      where id in (select id from public.acervo_previas
                    where organization_id = $1 and gravada_em is null and expira_em < now() - interval '5 minutes'
                    order by expira_em limit 20)
      returning fotos`,
    [org],
  );
  const fotos = (rows as Array<{ fotos: string[] | null }>).flatMap((r) => r.fotos ?? []).filter((c) => c.startsWith(`${org}/`));
  if (fotos.length > 0) await armazem.apagar(fotos);
  return rows.length;
}

// cadastro

export interface DadosDoCadastro {
  codigo?: string | null;
  modelo: string;
  cor: string;
  tamanho: string;
  uso: Uso;
  preco_venda_centavos?: number | null;
  preco_locacao_centavos?: number | null;
  descricao?: string | null;
  observacoes?: string | null;
}

async function sugerirCodigo(db: Consulta, org: string): Promise<string> {
  const { rows } = await db.query(
    `select coalesce(max(substring(codigo from '^A-([0-9]{1,9})$')::bigint), 0)::text as n
       from public.catalog_products where organization_id = $1 and codigo ~ '^A-[0-9]{1,9}$'`,
    [org],
  );
  return formatarCodigo(Number((rows[0] as { n: string }).n) + 1);
}

async function codigoTomado(db: Consulta, org: string, codigo: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from public.catalog_products where organization_id = $1 and codigo = $2 limit 1`,
    [org, codigo],
  );
  return rows.length > 0;
}

export async function previaCadastro(
  db: Db,
  armazem: Armazem,
  org: string,
  entrada: DadosDoCadastro,
  fotos: Uint8Array[],
  tokenId: string | null,
): Promise<Previa | Falha> {
  await limparPreviasVencidas(db, armazem, org).catch(() => 0);
  const modelo = limparTexto(entrada.modelo);
  const cor = limparTexto(entrada.cor);
  const tamanho = limparTexto(entrada.tamanho);
  if (!modelo || !cor || !tamanho) return falha("faltam_dados", 422, "Modelo, cor e tamanho são obrigatórios.");
  if (!USOS.includes(entrada.uso)) return falha("uso_invalido", 422, "Uso é venda, locacao ou ambos.");
  const venda = entrada.uso === "locacao" ? null : (entrada.preco_venda_centavos ?? null);
  const locacao = entrada.uso === "venda" ? null : (entrada.preco_locacao_centavos ?? null);
  if (entrada.uso !== "locacao" && venda == null) return falha("falta_preco", 422, "Falta o preço de venda (em centavos).");
  if (entrada.uso !== "venda" && locacao == null) return falha("falta_preco", 422, "Falta o preço de locação (em centavos).");
  if (fotos.length > FOTOS_POR_PECA) return falha("fotos_demais", 422, `Cada peça tem no máximo ${FOTOS_POR_PECA} fotos.`);
  const conferidas = [];
  for (const [i, bytes] of fotos.entries()) {
    const c = conferirFoto(bytes);
    if (!c.ok) return falha(c.erro, c.erro === "foto_grande" ? 413 : 415, `Foto ${i + 1}: ${c.detalhe}`);
    conferidas.push({ bytes, tipo: c.tipo });
  }

  let codigo: string;
  let sugerido = false;
  if (entrada.codigo) {
    const c = normalizarCodigo(entrada.codigo);
    if (!c) return falha("codigo_invalido", 422, "O código usa letras, números, ponto, hífen ou sublinhado (até 40).");
    if (await codigoTomado(db, org, c)) return falha("codigo_ocupado", 409, `O código ${c} já é de outra peça ou produto.`);
    codigo = c;
  } else {
    codigo = await sugerirCodigo(db, org);
    sugerido = true;
  }

  const { rows: parecidas } = await db.query(
    `select codigo, status, publicada from public.acervo_pecas
      where organization_id = $1 and lower(modelo) = lower($2) and lower(cor) = lower($3) and lower(tamanho) = lower($4)
      order by codigo limit 20`,
    [org, modelo, cor, tamanho],
  );

  const pecaId = randomUUID();
  const caminhos: string[] = [];
  for (const f of conferidas) {
    const caminho = `${org}/${pecaId}/${randomUUID()}.${extensaoDe(f.tipo)}`;
    if (!(await armazem.subir(caminho, f.bytes, f.tipo))) {
      if (caminhos.length > 0) await armazem.apagar(caminhos).catch(() => undefined);
      return falha("falhou_foto", 502, "Não deu para guardar a foto. Tente de novo.");
    }
    caminhos.push(caminho);
  }

  const campos = {
    codigo,
    modelo,
    cor,
    tamanho,
    uso: entrada.uso,
    preco_venda_centavos: venda,
    preco_locacao_centavos: locacao,
    descricao: limparTexto(entrada.descricao)?.slice(0, 1000) ?? null,
    observacoes: limparTexto(entrada.observacoes)?.slice(0, 2000) ?? null,
  };
  const p = await guardarPrevia(db, org, "cadastro", { peca_id: pecaId, ...campos }, caminhos, tokenId);
  const iguais = (parecidas as Array<{ codigo: string }>).map((r) => r.codigo);
  return {
    ok: true,
    ...p,
    vai_gravar: { ...campos, codigo_sugerido: sugerido, fotos: caminhos.length, status: "disponivel", publicada: false },
    parecidas,
    aviso_de_duplicada: iguais.length > 0 ? `Já existe peça com o mesmo modelo, cor e tamanho: ${iguais.join(", ")}.` : null,
  };
}

// publicar

export async function previaPublicar(db: Db, org: string, codigoBruto: string, publicar: boolean, tokenId: string | null): Promise<Previa | Falha> {
  const codigo = normalizarCodigo(codigoBruto);
  const l = codigo ? await pecaPorCodigo(db, org, codigo) : null;
  if (!l) return falha("peca_inexistente", 404, "Não achei peça com esse código.");
  const peca = pecaDaLinha(l);
  if (peca.publicada === publicar) return falha("nada_muda", 422, publicar ? "A peça já está publicada." : "A peça já não está publicada.");
  if (publicar && peca.status === "vendida") return falha("peca_vendida", 409, "Peça vendida não é publicada.");
  const p = await guardarPrevia(db, org, "publicar", { peca_id: l.id, codigo: peca.codigo, de: peca.publicada, para: publicar }, [], tokenId);
  return { ok: true, ...p, vai_gravar: { codigo: peca.codigo, publicada_antes: peca.publicada, publicada_depois: publicar }, peca };
}

// status

export async function previaStatus(db: Db, org: string, codigoBruto: string, para: Status, motivo: string | null, tokenId: string | null): Promise<Previa | Falha> {
  if (!STATUS.includes(para)) return falha("status_invalido", 422, `Status é um de: ${STATUS.join(", ")}.`);
  const codigo = normalizarCodigo(codigoBruto);
  const l = codigo ? await pecaPorCodigo(db, org, codigo) : null;
  if (!l) return falha("peca_inexistente", 404, "Não achei peça com esse código.");
  const peca = pecaDaLinha(l);
  if (peca.status === para) return falha("nada_muda", 422, `A peça já está ${para}.`);
  if (para === "alugada" && peca.uso === "venda") return falha("peca_so_de_venda", 422, "Esta peça é só de venda.");
  const contaAluguel = para === "alugada";
  const despublica = para === "vendida" && peca.publicada;
  const m = limparTexto(motivo)?.slice(0, 500) ?? null;
  const p = await guardarPrevia(db, org, "status", { peca_id: l.id, codigo: peca.codigo, de: peca.status, para, motivo: m, conta_aluguel: contaAluguel, despublica }, [], tokenId);
  return {
    ok: true,
    ...p,
    vai_gravar: {
      codigo: peca.codigo,
      de: peca.status,
      para,
      motivo: m,
      conta_aluguel: contaAluguel,
      vezes_alugada_depois: peca.vezes_alugada + (contaAluguel ? 1 : 0),
      despublica,
    },
    peca,
  };
}

// reserva

interface Conflito { reserva_id: string; data_evento: string; retirada: string; devolucao: string; cliente: string | null }

async function conflitos(db: Consulta, org: string, pecaId: string, retirada: string, devolucao: string): Promise<Conflito[]> {
  const { rows } = await db.query(
    `select id as reserva_id, data_evento::text, retirada::text, devolucao::text, cliente
       from public.acervo_reservas
      where organization_id = $1 and peca_id = $2 and status = 'ativa'
        and retirada <= $4::date and devolucao >= $3::date
      order by retirada`,
    [org, pecaId, retirada, devolucao],
  );
  return rows as Conflito[];
}

export async function previaReserva(
  db: Db,
  org: string,
  entrada: { codigo: string; data_evento: string; cliente?: string | null; observacoes?: string | null },
  tokenId: string | null,
  agora: Date = new Date(),
): Promise<Previa | Falha> {
  if (!dataValida(entrada.data_evento)) return falha("data_invalida", 422, "A data do evento vai no formato AAAA-MM-DD.");
  const codigo = normalizarCodigo(entrada.codigo);
  const l = codigo ? await pecaPorCodigo(db, org, codigo) : null;
  if (!l) return falha("peca_inexistente", 404, "Não achei peça com esse código.");
  const peca = pecaDaLinha(l);
  if (peca.uso === "venda") return falha("peca_so_de_venda", 422, "Esta peça é só de venda.");
  if (peca.status === "vendida") return falha("peca_vendida", 409, "Esta peça já foi vendida.");
  const fuso = await fusoDaOrganizacao(db, org).catch(() => FUSO_PADRAO);
  if (entrada.data_evento < hojeNoFuso(agora, fuso)) return falha("data_no_passado", 422, "A data do evento já passou.");
  const janela = janelaDaReserva(entrada.data_evento, fuso);
  const ocupada = await conflitos(db, org, l.id, janela.retirada, janela.devolucao);
  if (ocupada.length > 0) {
    return falha("peca_ocupada", 409, "A peça já está reservada nesse período.", { ...janela, conflitos: ocupada });
  }
  const campos = {
    codigo: peca.codigo,
    data_evento: entrada.data_evento,
    ...janela,
    cliente: limparTexto(entrada.cliente)?.slice(0, 200) ?? null,
    observacoes: limparTexto(entrada.observacoes)?.slice(0, 1000) ?? null,
  };
  const p = await guardarPrevia(db, org, "reserva", { peca_id: l.id, ...campos }, [], tokenId);
  return { ok: true, ...p, vai_gravar: campos, peca };
}

export async function previaCancelarReserva(db: Db, org: string, reservaId: string, tokenId: string | null): Promise<Previa | Falha> {
  const { rows } = await db.query(
    `select r.id, r.status, r.data_evento::text, r.retirada::text, r.devolucao::text, r.cliente, ap.codigo
       from public.acervo_reservas r
       join public.acervo_pecas ap on ap.organization_id = r.organization_id and ap.id = r.peca_id
      where r.organization_id = $1 and r.id = $2`,
    [org, reservaId],
  );
  const r = rows[0] as { id: string; status: string; data_evento: string; retirada: string; devolucao: string; cliente: string | null; codigo: string } | undefined;
  if (!r) return falha("reserva_inexistente", 404, "Não achei essa reserva.");
  if (r.status !== "ativa") return falha("nada_muda", 422, "A reserva já está cancelada.");
  const campos = { reserva_id: r.id, codigo: r.codigo, data_evento: r.data_evento, retirada: r.retirada, devolucao: r.devolucao, cliente: r.cliente };
  const p = await guardarPrevia(db, org, "cancelar_reserva", campos, [], tokenId);
  return { ok: true, ...p, vai_gravar: { ...campos, status_depois: "cancelada" } };
}

// ── gravar ───────────────────────────────────────────────────────────────────

export type Gravado = { ok: true; acao: AcaoDaPrevia; repetido: boolean; [k: string]: unknown };
type Aplicado = Record<string, unknown> | Falha;
const ehFalha = (x: Aplicado): x is Falha => (x as Falha).ok === false;
const mudou = (detalhe: string, extra?: Record<string, unknown>) => falha("mudou_desde_a_previa", 409, detalhe, extra);

async function aplicarCadastro(c: pg.PoolClient, org: string, d: Record<string, unknown>, fotos: string[]): Promise<Aplicado> {
  const codigo = String(d.codigo);
  if (await codigoTomado(c, org, codigo)) return mudou(`O código ${codigo} foi tomado depois da prévia. Faça a prévia de novo.`);
  const pecaId = String(d.peca_id);
  const campos = {
    modelo: String(d.modelo),
    cor: String(d.cor),
    tamanho: String(d.tamanho),
    uso: d.uso as Uso,
    preco_venda_centavos: numeroOuNulo(d.preco_venda_centavos),
    preco_locacao_centavos: numeroOuNulo(d.preco_locacao_centavos),
    descricao: (d.descricao as string | null) ?? null,
  };
  const e = espelhoNoCatalogo(campos);
  const fotosDaPeca = fotos.filter((f) => f.startsWith(`${org}/${pecaId}/`)).slice(0, FOTOS_POR_PECA);
  await c.query(
    `insert into public.catalog_products
       (id, organization_id, codigo, nome, descricao, categoria, preco_cents, moeda, controla_estoque, quantidade, ativo, origem, fotos)
     values ($1, $2, $3, $4, $5, 'acervo', $6, 'BRL', true, 1, false, 'acervo', $7::text[])`,
    [pecaId, org, codigo, e.nome, e.descricao || null, e.preco_cents, fotosDaPeca],
  );
  await c.query(
    `insert into public.acervo_pecas
       (id, organization_id, codigo, modelo, cor, tamanho, uso, preco_venda_cents, preco_locacao_cents, descricao, observacoes)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [pecaId, org, codigo, campos.modelo, campos.cor, campos.tamanho, campos.uso, campos.preco_venda_centavos, campos.preco_locacao_centavos, campos.descricao, (d.observacoes as string | null) ?? null],
  );
  await c.query(
    `insert into public.acervo_status_historico (organization_id, peca_id, de, para, motivo) values ($1, $2, null, 'disponivel', 'cadastro')`,
    [org, pecaId],
  );
  const l = await pecaPorId(c, org, pecaId);
  return { peca: pecaDaLinha(l!) };
}

async function aplicarPublicar(c: pg.PoolClient, org: string, d: Record<string, unknown>): Promise<Aplicado> {
  const l = await pecaPorId(c, org, String(d.peca_id), true);
  if (!l) return falha("peca_inexistente", 404, "A peça não existe mais.");
  if ((l.publicada === true) !== (d.de === true)) return mudou("A publicação da peça mudou depois da prévia.");
  if (d.para === true && l.status === "vendida") return mudou("A peça foi vendida depois da prévia.");
  await c.query(
    `update public.acervo_pecas set publicada = $3, publicada_em = case when $3 then now() else null end
      where organization_id = $1 and id = $2`,
    [org, l.id, d.para === true],
  );
  await c.query(`update public.catalog_products set ativo = $3 where organization_id = $1 and id = $2`, [org, l.id, d.para === true]);
  return { peca: pecaDaLinha((await pecaPorId(c, org, l.id))!) };
}

async function aplicarStatus(c: pg.PoolClient, org: string, d: Record<string, unknown>): Promise<Aplicado> {
  const l = await pecaPorId(c, org, String(d.peca_id), true);
  if (!l) return falha("peca_inexistente", 404, "A peça não existe mais.");
  if (l.status !== d.de) return mudou(`O status da peça mudou depois da prévia (agora: ${String(l.status)}).`);
  const para = d.para as Status;
  const publicada = d.despublica === true ? false : l.publicada === true;
  await c.query(
    `update public.acervo_pecas
        set status = $3, vezes_alugada = vezes_alugada + $4, publicada = $5,
            publicada_em = case when $5 then publicada_em else null end
      where organization_id = $1 and id = $2`,
    [org, l.id, para, d.conta_aluguel === true ? 1 : 0, publicada],
  );
  await c.query(
    `insert into public.acervo_status_historico (organization_id, peca_id, de, para, motivo) values ($1, $2, $3, $4, $5)`,
    [org, l.id, d.de, para, (d.motivo as string | null) ?? null],
  );
  await c.query(
    `update public.catalog_products set quantidade = $3, ativo = $4 where organization_id = $1 and id = $2`,
    [org, l.id, para === "disponivel" ? 1 : 0, publicada],
  );
  return { peca: pecaDaLinha((await pecaPorId(c, org, l.id))!) };
}

async function aplicarReserva(c: pg.PoolClient, org: string, d: Record<string, unknown>): Promise<Aplicado> {
  const l = await pecaPorId(c, org, String(d.peca_id), true);
  if (!l) return falha("peca_inexistente", 404, "A peça não existe mais.");
  if (l.status === "vendida") return mudou("A peça foi vendida depois da prévia.");
  const retirada = String(d.retirada);
  const devolucao = String(d.devolucao);
  const ocupada = await conflitos(c, org, l.id, retirada, devolucao);
  if (ocupada.length > 0) return mudou("A peça foi reservada nesse período depois da prévia.", { conflitos: ocupada });
  const { rows } = await c.query(
    `insert into public.acervo_reservas (organization_id, peca_id, data_evento, retirada, devolucao, cliente, observacoes)
     values ($1, $2, $3::date, $4::date, $5::date, $6, $7)
     returning id`,
    [org, l.id, d.data_evento, retirada, devolucao, (d.cliente as string | null) ?? null, (d.observacoes as string | null) ?? null],
  );
  return {
    reserva: {
      reserva_id: (rows[0] as { id: string }).id,
      codigo: l.codigo,
      data_evento: d.data_evento,
      retirada,
      devolucao,
      cliente: (d.cliente as string | null) ?? null,
      status: "ativa",
    },
  };
}

async function aplicarCancelarReserva(c: pg.PoolClient, org: string, d: Record<string, unknown>): Promise<Aplicado> {
  const { rows } = await c.query(
    `update public.acervo_reservas set status = 'cancelada', cancelada_em = now()
      where organization_id = $1 and id = $2 and status = 'ativa'
      returning id`,
    [org, d.reserva_id],
  );
  if (rows.length === 0) return mudou("A reserva já não está ativa.");
  return { reserva: { reserva_id: d.reserva_id, codigo: d.codigo, data_evento: d.data_evento, status: "cancelada" } };
}

export async function gravarPrevia(db: Db, org: string, idPrevia: string): Promise<Gravado | Falha> {
  const c = await db.connect();
  try {
    await c.query("begin");
    const { rows } = await c.query(
      `select id, acao, dados, fotos, gravada_em, resultado, (expira_em <= now()) as vencida
         from public.acervo_previas where organization_id = $1 and id = $2 for update`,
      [org, idPrevia],
    );
    const p = rows[0] as { acao: AcaoDaPrevia; dados: Record<string, unknown>; fotos: string[] | null; gravada_em: Date | null; resultado: Record<string, unknown> | null; vencida: boolean } | undefined;
    if (!p) {
      await c.query("rollback");
      return falha("previa_inexistente", 404, "Não achei essa prévia.");
    }
    if (p.gravada_em) {
      await c.query("commit");
      return { ok: true, acao: p.acao, repetido: true, ...(p.resultado ?? {}) };
    }
    if (p.vencida) {
      await c.query("rollback");
      return falha("previa_vencida", 410, `A prévia vale ${VALIDADE_DA_PREVIA_MINUTOS} minutos. Faça de novo.`);
    }
    const r =
      p.acao === "cadastro" ? await aplicarCadastro(c, org, p.dados, p.fotos ?? [])
      : p.acao === "publicar" ? await aplicarPublicar(c, org, p.dados)
      : p.acao === "status" ? await aplicarStatus(c, org, p.dados)
      : p.acao === "reserva" ? await aplicarReserva(c, org, p.dados)
      : await aplicarCancelarReserva(c, org, p.dados);
    if (ehFalha(r)) {
      await c.query("rollback");
      return r;
    }
    await c.query(`update public.acervo_previas set gravada_em = now(), resultado = $2::jsonb where id = $1`, [idPrevia, JSON.stringify(r)]);
    await c.query("commit");
    return { ok: true, acao: p.acao, repetido: false, ...r };
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    if ((e as { code?: string }).code === "23505") return mudou("O código foi tomado depois da prévia. Faça a prévia de novo.");
    throw e;
  } finally {
    c.release();
  }
}

// ── leituras (sem prévia, sem "sim") ─────────────────────────────────────────

export interface FiltroDePecas {
  codigo?: string | null;
  modelo?: string | null;
  cor?: string | null;
  tamanho?: string | null;
  uso?: Uso | null;
  status?: Status | null;
  publicada?: boolean | null;
  limite?: number | null;
}

function filtroSql(f: FiltroDePecas, args: unknown[]): string {
  const partes: string[] = [];
  const add = (sql: string, v: unknown) => {
    args.push(v);
    partes.push(sql.replace("?", `$${args.length}`));
  };
  const codigo = f.codigo ? normalizarCodigo(f.codigo) : null;
  if (f.codigo) add("ap.codigo = ?", codigo ?? "");
  const like = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  if (limparTexto(f.modelo)) add("ap.modelo ilike ?", like(limparTexto(f.modelo)!));
  if (limparTexto(f.cor)) add("ap.cor ilike ?", like(limparTexto(f.cor)!));
  if (limparTexto(f.tamanho)) add("lower(ap.tamanho) = lower(?)", limparTexto(f.tamanho));
  if (f.uso) add("ap.uso = ?", f.uso);
  if (f.status) add("ap.status = ?", f.status);
  if (typeof f.publicada === "boolean") add("ap.publicada = ?", f.publicada);
  return partes.map((p) => ` and ${p}`).join("");
}

export async function consultar(db: Consulta, org: string, f: FiltroDePecas, agora: Date = new Date()) {
  const args: unknown[] = [org];
  const onde = filtroSql(f, args);
  const limite = Math.min(Math.max(f.limite ?? 50, 1), 200);
  const { rows } = await db.query(`${SELECT_PECA} where ap.organization_id = $1${onde} order by ap.codigo limit ${limite}`, args);
  const pecas = (rows as LinhaDaPeca[]).map(pecaDaLinha);
  if (!f.codigo) return { ok: true as const, pecas, total: pecas.length };
  const l = rows[0] as LinhaDaPeca | undefined;
  if (!l) return { ok: true as const, pecas: [], total: 0 };
  const fuso = await fusoDaOrganizacao(db, org).catch(() => FUSO_PADRAO);
  const [{ rows: historico }, { rows: reservas }] = await Promise.all([
    db.query(
      `select de, para, motivo, created_at from public.acervo_status_historico
        where organization_id = $1 and peca_id = $2 order by created_at desc limit 20`,
      [org, l.id],
    ),
    db.query(
      `select id as reserva_id, data_evento::text, retirada::text, devolucao::text, cliente
         from public.acervo_reservas
        where organization_id = $1 and peca_id = $2 and status = 'ativa' and devolucao >= $3::date
        order by retirada`,
      [org, l.id, hojeNoFuso(agora, fuso)],
    ),
  ]);
  return { ok: true as const, pecas, total: pecas.length, historico, reservas };
}

export async function disponibilidade(db: Consulta, org: string, dataEvento: string, f: FiltroDePecas) {
  if (!dataValida(dataEvento)) return falha("data_invalida", 422, "A data do evento vai no formato AAAA-MM-DD.");
  const fuso = await fusoDaOrganizacao(db, org).catch(() => FUSO_PADRAO);
  const janela = janelaDaReserva(dataEvento, fuso);
  const args: unknown[] = [org];
  const onde = filtroSql({ ...f, uso: null, status: null }, args);
  const limite = Math.min(Math.max(f.limite ?? 100, 1), 200);
  args.push(janela.retirada, janela.devolucao);
  const r = args.length;
  const { rows } = await db.query(
    `select q.*, (
        select coalesce(json_agg(json_build_object('data_evento', x.data_evento::text, 'retirada', x.retirada::text, 'devolucao', x.devolucao::text) order by x.retirada), '[]'::json)
          from public.acervo_reservas x
         where x.organization_id = q.org and x.peca_id = q.id and x.status = 'ativa'
           and x.retirada <= $${r}::date and x.devolucao >= $${r - 1}::date
      ) as ocupada_por
       from (${SELECT_PECA.replace("select ap.id,", "select ap.organization_id as org, ap.id,")}
              where ap.organization_id = $1 and ap.uso in ('locacao', 'ambos') and ap.status <> 'vendida'${onde}
              order by ap.codigo limit ${limite}) q`,
    args,
  );
  const pecas = (rows as Array<LinhaDaPeca & { ocupada_por: unknown[] }>).map((l) => ({
    ...pecaDaLinha(l),
    livre: (l.ocupada_por ?? []).length === 0,
    ocupada_por: l.ocupada_por ?? [],
  }));
  return { ok: true as const, data_evento: dataEvento, ...janela, pecas, livres: pecas.filter((p) => p.livre).length };
}
