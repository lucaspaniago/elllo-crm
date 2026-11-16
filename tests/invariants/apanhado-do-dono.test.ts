/**
 * O APANHADO DO DONO NO BANCO — migration 9004 (fork elllo).
 *
 * ## O que este arquivo prova, contra o Postgres que nasce do `baseline.sql`
 *
 *   · VOCABULÁRIO — os CHECK de `itens_do_apanhado` (`tipo`, `origem`) aceitam
 *     EXATAMENTE as tuplas do TypeScript (`TIPOS_DO_ITEM`, `ORIGENS_DO_ITEM`);
 *   · RLS — tabela tenant-aware nova: o `manager` lê a própria organização, o
 *     vizinho lê zero de A (e um da dele — isolamento, não tabela vazia), o
 *     `viewer` lê zero, e `authenticated` não escreve em verbo nenhum. O mesmo
 *     eixo de `entregas_de_aviso_de_passagem` (9002);
 *   · IDEMPOTÊNCIA — a `unique (organization_id, message_id, tipo)` devolve
 *     `23505`: o webhook em dobro não põe a mesma mensagem duas vezes;
 *   · CASCATA — apagar a mensagem leva o item junto (o texto nunca mora aqui).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { ORIGENS_DO_ITEM, TIPOS_DO_ITEM } from "@/lib/escalacao/vocabulario-do-apanhado";

import { motivoDoErro, sql } from "./psql-transporte";

// Namespace próprio (90040000-).
const ORG_A = "90040000-0000-4000-8000-000000000001";
const ORG_B = "90040000-0000-4000-8000-000000000002";
const GESTOR_A = "90040000-1111-4000-8000-000000000001";
const LEITOR_A = "90040000-1111-4000-8000-000000000002";
const ADMIN_A = "90040000-1111-4000-8000-000000000003";
const ADMIN_B = "90040000-1111-4000-8000-000000000004";
const SESSAO_A = "90040000-2222-4000-8000-000000000001";
const SESSAO_B = "90040000-2222-4000-8000-000000000002";
const CONTATO_A = "90040000-3333-4000-8000-000000000001";
const CONTATO_B = "90040000-3333-4000-8000-000000000002";
const CONVERSA_A = "90040000-4444-4000-8000-000000000001";
const CONVERSA_B = "90040000-4444-4000-8000-000000000002";
const MENSAGEM_A = "90040000-5555-4000-8000-000000000001";
const MENSAGEM_B = "90040000-5555-4000-8000-000000000002";
const MENSAGEM_APAGADA = "90040000-5555-4000-8000-000000000003";

function comoMembro(userId: string): string {
  return `set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);`;
}

function valor(consulta: string): string {
  return (sql(consulta).trim().split("\n").at(-1) ?? "").trim();
}

function contaComoMembro(userId: string, consulta: string): number {
  const ultima = valor(`${comoMembro(userId)}\n${consulta};`);
  if (!/^\d+$/.test(ultima)) throw new Error(`saída inesperada do psql: ${ultima}`);
  return Number(ultima);
}

function erroDe(script: string): string {
  try {
    sql(script);
    return "";
  } catch (e) {
    return motivoDoErro(e);
  }
}

/** Os literais do CHECK que DEFINE o vocabulário da coluna — e só dele. */
function valoresDoCheck(tabela: string, coluna: string): string[] {
  const defs = sql(`
    select pg_get_constraintdef(k.oid)
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_attribute a on a.attrelid = c.oid and a.attnum = any(k.conkey)
     where k.contype = 'c' and c.relname = '${tabela}' and a.attname = '${coluna}'
       and array_length(k.conkey, 1) = 1;`)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("ANY") || l.includes(" IN "));
  if (defs.length !== 1) {
    throw new Error(`INSTRUMENTO: ${tabela}.${coluna} tem ${defs.length} CHECK de conjunto — esperava 1`);
  }
  const valores = [...defs[0]!.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!);
  if (valores.length === 0) throw new Error(`INSTRUMENTO: nenhum literal lido de ${defs[0]}`);
  return valores.sort();
}

const ITENS = "select count(*) from public.itens_do_apanhado";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${GESTOR_A}', 'apanhado-9004-gestor-a@invariant.test'),
      ('${LEITOR_A}', 'apanhado-9004-viewer-a@invariant.test'),
      ('${ADMIN_A}',  'apanhado-9004-admin-a@invariant.test'),
      ('${ADMIN_B}',  'apanhado-9004-admin-b@invariant.test')
      on conflict do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'apanhado-9004-a', 'Apanhado 9004 A', 'Apanhado 9004 A'),
      ('${ORG_B}', 'apanhado-9004-b', 'Apanhado 9004 B', 'Apanhado 9004 B')
      on conflict do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GESTOR_A}', '${ORG_A}', 'manager', now()),
      ('${LEITOR_A}', '${ORG_A}', 'viewer',  now()),
      ('${ADMIN_A}',  '${ORG_A}', 'admin',   now()),
      ('${ADMIN_B}',  '${ORG_B}', 'admin',   now())
      on conflict do nothing;

    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_A}', '${ORG_A}', 'apanhado-9004-a', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_B}', '${ORG_B}', 'apanhado-9004-b', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;

    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTATO_A}', '${ORG_A}', 'Apanhado 9004 Contato A'),
      ('${CONTATO_B}', '${ORG_B}', 'Apanhado 9004 Contato B')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${CONVERSA_A}', '${ORG_A}', '${CONTATO_A}', '${SESSAO_A}', 'closed'),
      ('${CONVERSA_B}', '${ORG_B}', '${CONTATO_B}', '${SESSAO_B}', 'closed')
      on conflict do nothing;

    insert into public.messages
        (id, organization_id, conversation_id, channel_session_id, contact_id, external_id, type, direction, status, body)
      values
        ('${MENSAGEM_A}', '${ORG_A}', '${CONVERSA_A}', '${SESSAO_A}', '${CONTATO_A}', 'apanhado-9004-a', 'text', 'inbound', 'delivered', 'propaganda A'),
        ('${MENSAGEM_B}', '${ORG_B}', '${CONVERSA_B}', '${SESSAO_B}', '${CONTATO_B}', 'apanhado-9004-b', 'text', 'inbound', 'delivered', 'propaganda B'),
        ('${MENSAGEM_APAGADA}', '${ORG_A}', '${CONVERSA_A}', '${SESSAO_A}', '${CONTATO_A}', 'apanhado-9004-c', 'text', 'inbound', 'delivered', 'vai sumir')
      on conflict do nothing;

    -- Um item em CADA organização: sem o do vizinho, "o vizinho lê zero de A"
    -- seria satisfeito por tabela vazia.
    insert into public.itens_do_apanhado (organization_id, tipo, origem, message_id, conversation_id, probabilidade)
      values ('${ORG_A}', 'propaganda', 'jev', '${MENSAGEM_A}', '${CONVERSA_A}', 0.97),
             ('${ORG_B}', 'propaganda', 'disparo_automatico', '${MENSAGEM_B}', '${CONVERSA_B}', null)
      on conflict do nothing;
  `);
});

describe("9004 — o vocabulário do banco é o do TypeScript", () => {
  it.each([
    ["tipo", TIPOS_DO_ITEM],
    ["origem", ORIGENS_DO_ITEM],
  ] as const)("itens_do_apanhado.%s", (coluna, tupla) => {
    expect(valoresDoCheck("itens_do_apanhado", coluna)).toEqual([...tupla].sort());
  });
});

describe("9004 — os itens são lidos por quem opera, e só da própria organização", () => {
  it("CONTROLE POSITIVO: o gestor de A lê o item de A", () => {
    expect(contaComoMembro(GESTOR_A, ITENS)).toBe(1);
  });

  it("o admin do VIZINHO lê o dele e zero de A", () => {
    expect(contaComoMembro(ADMIN_B, ITENS)).toBe(1);
    expect(contaComoMembro(ADMIN_B, `${ITENS} where organization_id = '${ORG_A}'`)).toBe(0);
  });

  it("`viewer` não lê os itens", () => {
    expect(contaComoMembro(LEITOR_A, ITENS)).toBe(0);
  });

  it.each([
    [
      "insert",
      `insert into public.itens_do_apanhado (organization_id, tipo, origem, message_id, conversation_id) values ('${ORG_A}', 'grupo', 'jev', '${MENSAGEM_A}', '${CONVERSA_A}')`,
    ],
    ["update", `update public.itens_do_apanhado set incluido_em = current_date where organization_id = '${ORG_A}'`],
    ["delete", `delete from public.itens_do_apanhado where organization_id = '${ORG_A}'`],
  ])("%s por `authenticated` é recusado até para o admin", (_verbo, comando) => {
    const erro = erroDe(`${comoMembro(ADMIN_A)}\n${comando};`);
    expect(erro, "a tabela ganhou uma porta de escrita").not.toBe("");
    expect(erro).toMatch(/permission denied|row-level security|violates/i);
  });
});

describe("9004 — idempotência, faixa e cascata", () => {
  it("a mesma (organização, mensagem, tipo) devolve 23505", () => {
    const erro = erroDe(
      `insert into public.itens_do_apanhado (organization_id, tipo, origem, message_id, conversation_id) values ('${ORG_A}', 'propaganda', 'disparo_automatico', '${MENSAGEM_A}', '${CONVERSA_A}');`,
    );
    expect(erro).toMatch(/duplicate key|itens_do_apanhado_unico/i);
  });

  it("probabilidade fora de 0..1 é recusada", () => {
    const erro = erroDe(
      `insert into public.itens_do_apanhado (organization_id, tipo, origem, message_id, conversation_id, probabilidade) values ('${ORG_A}', 'grupo', 'jev', '${MENSAGEM_A}', '${CONVERSA_A}', 1.5);`,
    );
    expect(erro).toMatch(/itens_do_apanhado_probabilidade_check|violates check/i);
  });

  it("apagar a mensagem leva o item junto", () => {
    sql(`insert into public.itens_do_apanhado (organization_id, tipo, origem, message_id, conversation_id)
           values ('${ORG_A}', 'propaganda', 'jev', '${MENSAGEM_APAGADA}', '${CONVERSA_A}')
           on conflict do nothing;
         delete from public.messages where id = '${MENSAGEM_APAGADA}';`);
    expect(Number(valor(`${ITENS} where message_id = '${MENSAGEM_APAGADA}';`))).toBe(0);
  });
});
