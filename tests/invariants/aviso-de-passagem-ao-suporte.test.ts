/**
 * O AVISO DE PASSAGEM AO DONO NO BANCO — migrations 9001 e 9002 (fork elllo).
 *
 * ## O que este arquivo prova, contra o Postgres que nasce do `baseline.sql`
 *
 *   · VOCABULÁRIO — os CHECK de `entregas_de_aviso_de_passagem` (`status`,
 *     `erro_codigo`, `hipotese`) aceitam EXATAMENTE as tuplas do TypeScript
 *     (`STATUS_DA_ENTREGA_DE_AVISO`, `ERROS_DA_ENTREGA_DE_AVISO`,
 *     `HIPOTESES_DA_PASSAGEM`). O compilador não lê o banco: sem isto, um código
 *     novo no TS viraria `23514` no INSERT de um caminho pouco exercitado;
 *   · RLS — tabela tenant-aware nova: o `manager` lê a própria organização, o
 *     vizinho lê zero de A (e um da dele — isolamento, não tabela vazia), o
 *     `viewer` lê zero, e `authenticated` não escreve em verbo nenhum. É o
 *     mesmo eixo da `entregas_de_aviso_de_caso` (0292), provado da mesma forma
 *     (`set role authenticated` + `request.jwt.claims`);
 *   · GATILHO — toda linha nova de `passagens_de_atendimento` emite UM
 *     `ai.handoff_recorded` com a organização e os ponteiros certos, e a função
 *     do gatilho não é alcançável por `anon`/`authenticated`;
 *   · IDEMPOTÊNCIA — a `unique (organization_id, passagem_id, destino)` devolve
 *     `23505`, o sinal que o handler lê para reler a entrega em vez de mandar
 *     o aviso de novo;
 *   · CONFIGURAÇÃO — `aviso_de_passagem_ligado` nasce `true`, `sondagem_minutos`
 *     nasce 10 e recusa fora de 0..60; `partes_enviadas` (9001 e 9002) recusa
 *     fora de 0..20.
 *
 * ⚠️ `tests/invariants/rls-completude-varredura.test.ts` deriva do catálogo toda
 * tabela com `organization_id` e exige que ela esteja em `TABLES` ou em
 * `PROVA_PROPRIA`. Este arquivo é a prova comportamental que aquela lista pede
 * para `entregas_de_aviso_de_passagem` — a entrada em `PROVA_PROPRIA` citando-o
 * é o passo que o fork NÃO deu, porque os invariantes do upstream estão
 * congelados (ver `docs/fork/elllo.md`).
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  ERROS_DA_ENTREGA_DE_AVISO,
  STATUS_DA_ENTREGA_DE_AVISO,
} from "@/lib/escalacao/vocabulario-do-aviso";
import { HIPOTESES_DA_PASSAGEM } from "@/lib/escalacao/vocabulario-do-aviso-de-passagem";

import { motivoDoErro, sql } from "./psql-transporte";

// Namespace próprio (90020000-).
const ORG_A = "90020000-0000-4000-8000-000000000001";
const ORG_B = "90020000-0000-4000-8000-000000000002";
const GESTOR_A = "90020000-1111-4000-8000-000000000001";
const LEITOR_A = "90020000-1111-4000-8000-000000000002";
const ADMIN_A = "90020000-1111-4000-8000-000000000003";
const ADMIN_B = "90020000-1111-4000-8000-000000000004";
const SESSAO_A = "90020000-2222-4000-8000-000000000001";
const SESSAO_B = "90020000-2222-4000-8000-000000000002";
const CONTATO_A = "90020000-3333-4000-8000-000000000001";
const CONTATO_B = "90020000-3333-4000-8000-000000000002";
const CONVERSA_A = "90020000-4444-4000-8000-000000000001";
const CONVERSA_B = "90020000-4444-4000-8000-000000000002";
const PASSAGEM_A = "90020000-5555-4000-8000-000000000001";
const PASSAGEM_B = "90020000-5555-4000-8000-000000000002";
const CASO_A = "90020000-6666-4000-8000-000000000001";
const DESTINO = "+5531998966398";

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

const ENTREGAS = "select count(*) from public.entregas_de_aviso_de_passagem";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${GESTOR_A}', 'aviso-9002-gestor-a@invariant.test'),
      ('${LEITOR_A}', 'aviso-9002-viewer-a@invariant.test'),
      ('${ADMIN_A}',  'aviso-9002-admin-a@invariant.test'),
      ('${ADMIN_B}',  'aviso-9002-admin-b@invariant.test')
      on conflict do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'aviso-9002-a', 'Aviso 9002 A', 'Aviso 9002 A'),
      ('${ORG_B}', 'aviso-9002-b', 'Aviso 9002 B', 'Aviso 9002 B')
      on conflict do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GESTOR_A}', '${ORG_A}', 'manager', now()),
      ('${LEITOR_A}', '${ORG_A}', 'viewer',  now()),
      ('${ADMIN_A}',  '${ORG_A}', 'admin',   now()),
      ('${ADMIN_B}',  '${ORG_B}', 'admin',   now())
      on conflict do nothing;

    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_A}', '${ORG_A}', 'aviso-9002-a', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;
    do $seed$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${SESSAO_B}', '${ORG_B}', 'aviso-9002-b', '\\x00'::bytea);
    exception when unique_violation then null; end $seed$;

    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTATO_A}', '${ORG_A}', 'Aviso 9002 Contato A'),
      ('${CONTATO_B}', '${ORG_B}', 'Aviso 9002 Contato B')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${CONVERSA_A}', '${ORG_A}', '${CONTATO_A}', '${SESSAO_A}', 'open'),
      ('${CONVERSA_B}', '${ORG_B}', '${CONTATO_B}', '${SESSAO_B}', 'open')
      on conflict do nothing;

    insert into public.config_aviso_de_caso (organization_id, channel_session_id, telefone_destino, ligado)
      values ('${ORG_A}', '${SESSAO_A}', '${DESTINO}', true)
      on conflict (organization_id) do update
        set channel_session_id = excluded.channel_session_id, ligado = excluded.ligado;

    insert into public.passagens_de_atendimento
        (id, organization_id, contact_id, conversation_id, motor, origem, motivo_codigo, body)
      select * from (values
        ('${PASSAGEM_A}'::uuid, '${ORG_A}'::uuid, '${CONTATO_A}'::uuid, '${CONVERSA_A}'::uuid,
         'crm', 'sentimento', 'low_sentiment', 'a narrativa da passagem A'),
        ('${PASSAGEM_B}'::uuid, '${ORG_B}'::uuid, '${CONTATO_B}'::uuid, '${CONVERSA_B}'::uuid,
         'engine', 'pedido_explicito', 'requested_human', 'a narrativa da passagem B')
      ) as s(id, organization_id, contact_id, conversation_id, motor, origem, motivo_codigo, body)
       where not exists (select 1 from public.passagens_de_atendimento where id = s.id);

    -- Um caso com entrega de aviso de caso, para medir o CHECK da 9001.
    insert into public.agent_cases (id, organization_id, conversation_id, status, source, title, summary, blocker)
      values ('${CASO_A}', '${ORG_A}', '${CONVERSA_A}', 'awaiting_human', 'agent', 'Aviso 9002 Caso', 'resumo', 'travou')
      on conflict do nothing;
    insert into public.entregas_de_aviso_de_caso (organization_id, case_id, destino, channel_session_id, status)
      values ('${ORG_A}', '${CASO_A}', '${DESTINO}', '${SESSAO_A}', 'enviado')
      on conflict do nothing;

    -- Uma entrega em CADA organização: sem a do vizinho, "o vizinho lê zero de
    -- A" seria satisfeito por tabela vazia.
    insert into public.entregas_de_aviso_de_passagem
        (organization_id, passagem_id, destino, channel_session_id, status, hipotese)
      values ('${ORG_A}', '${PASSAGEM_A}', '${DESTINO}', '${SESSAO_A}', 'enviado', 'brincadeira'),
             ('${ORG_B}', '${PASSAGEM_B}', '+5511988887777', '${SESSAO_B}', 'enviado', null)
      on conflict do nothing;
  `);
});

describe("9002 — o vocabulário do banco é o do TypeScript", () => {
  it.each([
    ["status", STATUS_DA_ENTREGA_DE_AVISO],
    ["erro_codigo", ERROS_DA_ENTREGA_DE_AVISO],
    ["hipotese", HIPOTESES_DA_PASSAGEM],
  ] as const)("entregas_de_aviso_de_passagem.%s", (coluna, tupla) => {
    expect(valoresDoCheck("entregas_de_aviso_de_passagem", coluna)).toEqual([...tupla].sort());
  });

  it("o erro_codigo do aviso de passagem é o MESMO conjunto do aviso de caso", () => {
    expect(valoresDoCheck("entregas_de_aviso_de_passagem", "erro_codigo")).toEqual(
      valoresDoCheck("entregas_de_aviso_de_caso", "erro_codigo"),
    );
  });
});

describe("9002 — o histórico é lido por quem opera, e só da própria organização", () => {
  it("CONTROLE POSITIVO: o gestor de A lê a entrega de A", () => {
    expect(contaComoMembro(GESTOR_A, ENTREGAS)).toBe(1);
  });

  it("o admin do VIZINHO lê a dele e zero de A", () => {
    expect(contaComoMembro(ADMIN_B, ENTREGAS)).toBe(1);
    expect(contaComoMembro(ADMIN_B, `${ENTREGAS} where organization_id = '${ORG_A}'`)).toBe(0);
  });

  it("`viewer` não lê o histórico", () => {
    expect(contaComoMembro(LEITOR_A, ENTREGAS)).toBe(0);
  });

  it.each([
    [
      "insert",
      `insert into public.entregas_de_aviso_de_passagem (organization_id, passagem_id, destino) values ('${ORG_A}', '${PASSAGEM_A}', '+5531900000000')`,
    ],
    ["update", `update public.entregas_de_aviso_de_passagem set status = 'falhou' where organization_id = '${ORG_A}'`],
    ["delete", `delete from public.entregas_de_aviso_de_passagem where organization_id = '${ORG_A}'`],
  ])("%s por `authenticated` é recusado até para o admin", (_verbo, comando) => {
    const erro = erroDe(`${comoMembro(ADMIN_A)}\n${comando};`);
    expect(erro, "a tabela ganhou uma porta de escrita").not.toBe("");
    expect(erro).toMatch(/permission denied|row-level security|violates/i);
  });
});

describe("9002 — a passagem anuncia no barramento", () => {
  it("o INSERT de uma passagem emite UM ai.handoff_recorded com os ponteiros certos", () => {
    const linha = valor(`
      select count(*) || '|' || coalesce(max(organization_id::text), '') || '|' ||
             coalesce(max(payload->>'conversation_id'), '') || '|' ||
             coalesce(max(payload->>'contact_id'), '') || '|' ||
             coalesce(max(payload->>'motivo_codigo'), '') || '|' ||
             coalesce(max(entity_kind), '')
        from public.event_log
       where event_type = 'ai.handoff_recorded' and entity_id = '${PASSAGEM_A}';`);
    expect(linha).toBe(
      `1|${ORG_A}|${CONVERSA_A}|${CONTATO_A}|low_sentiment|passagem_de_atendimento`,
    );
  });

  it("a função do gatilho não é alcançável por anon nem authenticated", () => {
    for (const papel of ["anon", "authenticated"]) {
      const pode = valor(
        `select has_function_privilege('${papel}', 'public.fn_emit_passagem_registrada()', 'EXECUTE')::text;`,
      );
      expect(pode, `${papel} executa fn_emit_passagem_registrada`).toBe("false");
    }
  });
});

describe("9002 — idempotência e configuração", () => {
  it("a mesma (organização, passagem, destino) devolve 23505", () => {
    const erro = erroDe(`
      insert into public.entregas_de_aviso_de_passagem (organization_id, passagem_id, destino)
        values ('${ORG_A}', '${PASSAGEM_A}', '${DESTINO}');`);
    expect(erro).toMatch(/duplicate key|unique/i);
  });

  it("os botões nascem com o padrão do dono: aviso ligado, sondagem de 10 min", () => {
    expect(
      valor(
        `select aviso_de_passagem_ligado::text || '|' || sondagem_minutos from public.config_aviso_de_caso where organization_id = '${ORG_A}';`,
      ),
    ).toBe("true|10");
  });

  it("sondagem_minutos fora de 0..60 é recusada", () => {
    expect(
      erroDe(`update public.config_aviso_de_caso set sondagem_minutos = 61 where organization_id = '${ORG_A}';`),
    ).toMatch(/violates check constraint/i);
    expect(
      erroDe(`update public.config_aviso_de_caso set sondagem_minutos = 0 where organization_id = '${ORG_A}';`),
    ).toBe("");
  });

  it.each(["entregas_de_aviso_de_passagem", "entregas_de_aviso_de_caso"])(
    "%s.partes_enviadas recusa fora de 0..20",
    (tabela) => {
      expect(
        erroDe(`update public.${tabela} set partes_enviadas = 21 where organization_id = '${ORG_A}';`),
      ).toMatch(/violates check constraint/i);
    },
  );
});
