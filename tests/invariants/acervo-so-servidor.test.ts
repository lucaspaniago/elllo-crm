import { describe, expect, it } from "vitest";

import { countAs, GOV_AGENT_A, sql } from "./gov-helpers";

/**
 * As quatro tabelas do ACERVO (fork elllo, acervo1, migration 9006) são EXCLUSIVAS DO
 * SERVIDOR: quem lê e grava é a rota `/api/v1/acervo`, por token, com o pool do servidor.
 *
 * Nascem tenant-aware (`organization_id not null`), e a varredura de completude exige prova
 * comportamental para tabela nova. Não entram em TABLES porque o usuário do teste (`agent`
 * da org) não tem SELECT — o controle positivo de lá falharia por ACERTO (o mesmo motivo de
 * `automation_rule_contact_claims`). A prova é a de "tabela do servidor": RLS de pé, nenhuma
 * policy, nenhum papel de navegador com privilégio, e o JWT da própria organização recusado.
 */
const TABELAS = ["acervo_pecas", "acervo_status_historico", "acervo_reservas", "acervo_previas"] as const;

describe("acervo: só o servidor passa", () => {
  it.each(TABELAS)("%s: RLS ligada e nenhuma policy", (t) => {
    expect(sql(`select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`)).toBe("t");
    expect(sql(`select count(*) from pg_policies where schemaname = 'public' and tablename = '${t}'`)).toBe("0");
  });

  it.each(TABELAS)("%s: anon e authenticated SEM privilégio; service_role com", (t) => {
    expect(
      sql(
        `select bool_and(not has_table_privilege(r, 'public.${t}', p))
           from unnest(array['anon','authenticated']) r, unnest(array['select','insert','update','delete']) p`,
      ),
    ).toBe("t");
    expect(sql(`select has_table_privilege('service_role', 'public.${t}', 'select')`)).toBe("t");
    expect(sql(`select has_table_privilege('service_role', 'public.${t}', 'insert')`)).toBe("t");
  });

  it.each(TABELAS)("%s: o JWT authenticated da própria org também é recusado", (t) => {
    expect(() =>
      countAs(GOV_AGENT_A, `select count(*) from public.${t} where organization_id = 'cccccccc-0000-4000-8000-000000000001';`),
    ).toThrow();
  });
});
