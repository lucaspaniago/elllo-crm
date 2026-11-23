-- manifest: Fork elllo — o dossiê de cada contato: lead_notes ganha categoria (conheceu, gostos, rotina, pendente, jeito, tom, fato), fonte (pessoa, helo, lucas; posta pelo código, nunca pelo modelo) e liberada (o que o Lucas contou e disse que pode usar com o contato); lead_dossie_flushes marca o atendimento fechado que já foi resumido no dossiê; fn_rapport_do_contato devolve só o rapport (sem conversa) ao servidor.
-- ═══════════════════════════════════════════════════════════════════════════
-- 9005 (fork elllo) — o dossiê por pessoa (rapport) da Helô do CRM.
--
-- Pedido do dono (23/11/2026): "colocando na ficha de cada contato as
-- informações necessárias para fazer esse rapport... Não só cliente".
--
-- **A ficha é `lead_notes`.** Nada de tabela nova para o conteúdo: a nota já é
-- a memória do agente sobre o contato, já está presa a (organização, contato),
-- já é redigida pela anonimização (0494/0497/9043: headline/body viram
-- '(anonimizado)' e o embedding vira null) e já aparece na tela. A 9005 só
-- acrescenta a cada linha:
--   * `categoria` — conheceu, gostos, rotina, pendente, jeito, tom, fato;
--   * `fonte` — quem contou: `pessoa` (o próprio contato, na conversa), `helo`
--     (observação da IA sobre o jeito ou o tom) ou `lucas` (alguém da empresa:
--     a tela, o mensageiro do dono). **Quem põe é o código**, pelo caminho da
--     escrita, nunca o modelo;
--   * `liberada` — só para `lucas`: o dono disse "pode usar com ele".
--
-- **O default de `fonte` é `lucas`, de propósito.** É a mais restrita: o que
-- não declara de onde veio (o mensageiro do dono grava pelo PostgREST, sem
-- saber da coluna) é tratado como o que o Lucas contou — entra no prompt para
-- dar contexto, mas a cerca do envio barra o texto que o repete ao contato.
-- O código do agente sempre declara `pessoa` ou `helo`.
--
-- **As notas que já existem** (antes da coluna): as "Recado do Lucas…" do
-- mensageiro viram `pendente|lucas`; as outras, gravadas pelo agente, viram
-- `fato|pessoa`. Só na primeira aplicação (o bloco testa se a coluna existe),
-- para a reaplicação nunca reclassificar nota nova.
--
-- **`lead_dossie_flushes`** marca o atendimento fechado que o laço do worker
-- (`lib/agent-engine/agent/dossie-ao-fechar.ts`) já resumiu no dossiê, um por
-- (conversa, revisão de serviço). Sem `organization_id` e sem texto: é só a
-- marca. RLS ligada sem policy e sem grant a anon/authenticated — só o
-- servidor lê e grava.
--
-- **`fn_rapport_do_contato`** é a leitura do mensageiro do Hermes: as notas do
-- contato por categoria, com a fonte, sem nenhuma mensagem da conversa e sem os
-- recados operacionais. Só `service_role` executa.
--
-- Reaplicável: `if not exists`, `drop … if exists` + `add`/`create`.
-- ═══════════════════════════════════════════════════════════════════════════

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'lead_notes' and column_name = 'fonte'
  ) then
    alter table public.lead_notes add column categoria text not null default 'fato';
    alter table public.lead_notes add column fonte text not null default 'lucas';
    alter table public.lead_notes add column liberada boolean not null default false;
    -- As notas de antes: recado do mensageiro é pendência contada pelo dono; o
    -- resto foi o agente que gravou, do que o contato disse.
    update public.lead_notes
       set categoria = 'pendente', fonte = 'lucas'
     where headline like 'Recado do Lucas%';
    update public.lead_notes
       set categoria = 'fato', fonte = 'pessoa'
     where headline not like 'Recado do Lucas%';
  end if;
end $$;

-- Vocabulário fechado, conferido contra o TypeScript por
-- tests/unit/dossie-do-contato.test.ts (`CATEGORIAS_DO_DOSSIE`,
-- `FONTES_DO_DOSSIE` em lib/agent-engine/agent/dossie.ts).
alter table public.lead_notes drop constraint if exists lead_notes_categoria_check;
alter table public.lead_notes add constraint lead_notes_categoria_check
  check (categoria in ('conheceu', 'gostos', 'rotina', 'pendente', 'jeito', 'tom', 'fato'));

alter table public.lead_notes drop constraint if exists lead_notes_fonte_check;
alter table public.lead_notes add constraint lead_notes_fonte_check
  check (fonte in ('pessoa', 'helo', 'lucas'));

-- "Pode usar com ele" só existe para o que o dono contou: o que o próprio
-- contato disse já é dele, e a observação da IA não vai ao contato.
alter table public.lead_notes drop constraint if exists lead_notes_liberada_check;
alter table public.lead_notes add constraint lead_notes_liberada_check
  check (not liberada or fonte = 'lucas');

-- A observação da IA é só sobre o jeito e o tom (a fonte `helo` não descreve
-- fato da vida de ninguém).
alter table public.lead_notes drop constraint if exists lead_notes_helo_so_jeito_e_tom_check;
alter table public.lead_notes add constraint lead_notes_helo_so_jeito_e_tom_check
  check (fonte <> 'helo' or categoria in ('jeito', 'tom'));

comment on column public.lead_notes.categoria is
  'Fork elllo (9005): conheceu, gostos, rotina, pendente, jeito, tom ou fato.';
comment on column public.lead_notes.fonte is
  'Fork elllo (9005): quem contou — pessoa (o contato), helo (observação da IA sobre jeito/tom) ou lucas (a empresa: tela ou mensageiro do dono). Posta pelo código; default lucas, a mais restrita.';
comment on column public.lead_notes.liberada is
  'Fork elllo (9005): o dono disse que pode usar com o contato. Só vale para fonte lucas.';

-- ── a marca do atendimento já resumido ─────────────────────────────────────
create table if not exists public.lead_dossie_flushes (
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  service_revision integer not null,
  status           text not null,
  notas_gravadas   integer not null default 0,
  created_at       timestamptz not null default now(),
  primary key (conversation_id, service_revision)
);

alter table public.lead_dossie_flushes drop constraint if exists lead_dossie_flushes_status_check;
alter table public.lead_dossie_flushes add constraint lead_dossie_flushes_status_check
  check (status in ('feito', 'sem_notas', 'falhou', 'sem_conversa'));

alter table public.lead_dossie_flushes enable row level security;
revoke all on public.lead_dossie_flushes from anon, authenticated;
grant  all on public.lead_dossie_flushes to service_role;

comment on table public.lead_dossie_flushes is
  'Fork elllo (9005): o atendimento fechado (conversa, revisão) que o worker já resumiu no dossiê (lead_notes). Só a marca, sem texto. Só o servidor lê e grava.';

-- ── a leitura de rapport do mensageiro ─────────────────────────────────────
create or replace function public.fn_rapport_do_contato(
  p_organization_id uuid,
  p_contact_id uuid default null,
  p_telefone text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- plpgsql e não sql: o corpo só é conferido na chamada, e o baseline cria esta
  -- função antes de `contact_phones` (9043) existir.
  return (
  with contato as (
    select c.id, c.display_name
      from public.contacts c
     where c.organization_id = p_organization_id
       and coalesce(c.is_anonymized, false) = false
       and (
         (p_contact_id is not null and c.id = p_contact_id)
         or (p_contact_id is null and p_telefone is not null and exists (
               select 1 from public.contact_phones cp
                where cp.organization_id = p_organization_id
                  and cp.contact_id = c.id
                  and public.fn_telefone_canonico(cp.phone_number) = public.fn_telefone_canonico(p_telefone)))
       )
     order by c.created_at
     limit 1
  )
  select case when not exists (select 1 from contato) then null else jsonb_build_object(
    'contact_id', (select id from contato),
    'nome', (select display_name from contato),
    'linhas', coalesce((
      select jsonb_agg(jsonb_build_object(
               'categoria', n.categoria,
               'fonte', n.fonte,
               'liberada', n.liberada,
               'titulo', n.headline,
               'texto', n.body,
               'quando', n.created_at)
             order by array_position(array['conheceu','gostos','rotina','pendente','jeito','tom','fato'], n.categoria), n.created_at)
        from public.lead_notes n
       where n.organization_id = p_organization_id
         and n.contact_id = (select id from contato)
         and n.headline not like 'Recado do Lucas%'
         and n.headline <> '(anonimizado)'
    ), '[]'::jsonb)
  ) end
  );
end;
$$;

revoke all on function public.fn_rapport_do_contato(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_rapport_do_contato(uuid, uuid, text) to service_role;

comment on function public.fn_rapport_do_contato(uuid, uuid, text) is
  'Fork elllo (9005): o rapport do contato (notas por categoria, com a fonte), para o mensageiro do Hermes. Sem mensagem da conversa e sem os recados operacionais. Só service_role.';

-- A API do PostgREST (o mensageiro chama a função por /rpc) relê o schema.
notify pgrst, 'reload schema';
