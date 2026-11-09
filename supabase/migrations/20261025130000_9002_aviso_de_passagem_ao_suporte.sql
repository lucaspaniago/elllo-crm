-- manifest: Fork elllo — aviso de passagem ao dono: entregas_de_aviso_de_passagem (espelho da 0292), botões aviso_de_passagem_ligado e sondagem_minutos na config do aviso, e o gatilho que emite ai.handoff_recorded a cada passagem gravada.
-- ═══════════════════════════════════════════════════════════════════════════
-- 9002 (fork elllo) — o WhatsApp do dono é avisado de TODA passagem para humano.
--
-- O aviso de caso (0292) só sai quando a IA abre um caso. Uma conversa que vai
-- para uma pessoa por sentimento, por pedido explícito ou por teto de gasto não
-- avisava ninguém fora da tela do CRM. Este arquivo é o schema desse segundo
-- aviso: o consumidor é `lib/escalacao/aviso-de-passagem-ao-suporte.ts`.
--
-- DIRC: `passagem_id` e `channel_session_id` são FK; `status`, `erro_codigo` e
-- `hipotese` são vocabulário fechado; "este aviso já saiu?" não é calculável
-- depois (a mesma resposta da 0292).
--
-- Faixa 9xxx = migrations do fork. Reaplicável: `if not exists`,
-- `drop … if exists` + `add`/`create`, `create or replace`. A tabela nasce aqui
-- e as colunas novas da configuração têm default, então nenhum CHECK encontra
-- dado a corrigir antes (regra 8 da doutrina de migrations).
-- ═══════════════════════════════════════════════════════════════════════════

-- A configuração ganha os dois botões do fork, na MESMA linha do aviso de caso:
-- o aviso de passagem vai pelo mesmo número e pela mesma conexão.
--   aviso_de_passagem_ligado — default true: quem já ligou o aviso de caso passa
--                              a receber também o de passagem;
--   sondagem_minutos         — quanto a sondagem espera a resposta do cliente
--                              antes de passar (0 = sem sondagem).
alter table public.config_aviso_de_caso
  add column if not exists aviso_de_passagem_ligado boolean not null default true;
alter table public.config_aviso_de_caso
  add column if not exists sondagem_minutos smallint not null default 10;

alter table public.config_aviso_de_caso
  drop constraint if exists config_aviso_de_caso_sondagem_minutos_check;
alter table public.config_aviso_de_caso
  add constraint config_aviso_de_caso_sondagem_minutos_check
  check (sondagem_minutos between 0 and 60);

-- A ENTREGA do aviso de passagem — espelho de `entregas_de_aviso_de_caso`
-- (0292). Sem `erro_detalhe` (o texto cru do transporte é a única coluna capaz
-- de ecoar um número; aqui ele fica no log), sem FK para `contacts` e sem coluna
-- de texto do cliente: o aviso NUNCA é guardado, só o hash dele, e da avaliação
-- só a hipótese.
create table if not exists public.entregas_de_aviso_de_passagem (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  passagem_id         uuid not null references public.passagens_de_atendimento(id) on delete cascade,
  -- O destino NO INSTANTE do envio — registro, não estado (mesma razão da 0292).
  destino             text not null,
  channel_session_id  uuid references public.channel_sessions(id) on delete set null,
  status              text not null default 'pendente',
  tentativas          smallint not null default 0,
  partes_enviadas     smallint not null default 0,
  erro_codigo         text,
  external_id         text,
  corpo_hash          text,
  hipotese            text,
  enviado_em          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.entregas_de_aviso_de_passagem
  add column if not exists channel_session_id uuid,
  add column if not exists partes_enviadas    smallint not null default 0,
  add column if not exists erro_codigo        text,
  add column if not exists external_id        text,
  add column if not exists corpo_hash         text,
  add column if not exists hipotese           text,
  add column if not exists enviado_em         timestamptz;

-- Os CHECK nomeados fora do `create table` (auto-curativos, um por coluna).
-- `status` e `erro_codigo` são o MESMO vocabulário da 0292 —
-- `STATUS_DA_ENTREGA_DE_AVISO` e `ERROS_DA_ENTREGA_DE_AVISO`
-- (lib/escalacao/vocabulario-do-aviso.ts); `hipotese` é
-- `HIPOTESES_DA_PASSAGEM` (lib/escalacao/vocabulario-do-aviso-de-passagem.ts).
-- Quem confere os três contra o TypeScript é
-- tests/invariants/aviso-de-passagem-ao-suporte.test.ts.
alter table public.entregas_de_aviso_de_passagem
  drop constraint if exists entregas_de_aviso_de_passagem_status_check;
alter table public.entregas_de_aviso_de_passagem
  add constraint entregas_de_aviso_de_passagem_status_check
  check (status in ('pendente', 'enviado', 'falhou', 'cancelado'));

alter table public.entregas_de_aviso_de_passagem
  drop constraint if exists entregas_de_aviso_de_passagem_erro_codigo_check;
alter table public.entregas_de_aviso_de_passagem
  add constraint entregas_de_aviso_de_passagem_erro_codigo_check
  check (erro_codigo is null or erro_codigo in (
    'canal_desconectado',
    'canal_arquivado',
    'canal_nao_aceita_aviso_livre',
    'canal_desativado',
    'transporte_ausente',
    'destino_invalido',
    'destino_da_propria_organizacao',
    'teto_diario_do_numero',
    'sem_endereco_publico',
    'titular_anonimizado',
    'expirou',
    'falha_no_envio',
    'indeterminado'));

alter table public.entregas_de_aviso_de_passagem
  drop constraint if exists entregas_de_aviso_de_passagem_hipotese_check;
alter table public.entregas_de_aviso_de_passagem
  add constraint entregas_de_aviso_de_passagem_hipotese_check
  check (hipotese is null or hipotese in ('brincadeira', 'irritacao_real', 'engano', 'outro'));

alter table public.entregas_de_aviso_de_passagem
  drop constraint if exists entregas_de_aviso_de_passagem_partes_enviadas_check;
alter table public.entregas_de_aviso_de_passagem
  add constraint entregas_de_aviso_de_passagem_partes_enviadas_check
  check (partes_enviadas between 0 and 20);

-- A CHAVE DA IDEMPOTÊNCIA: o handler reivindica no INSERT e lê o `23505` como
-- "outro processo chegou primeiro" — o mesmo desenho da 0292.
create unique index if not exists entregas_de_aviso_de_passagem_unica
  on public.entregas_de_aviso_de_passagem (organization_id, passagem_id, destino);

-- Leitor declarado: "outra passagem desta conversa já foi avisada há menos de
-- 30 min?" e a leitura do histórico pela organização.
create index if not exists entregas_de_aviso_de_passagem_org_idx
  on public.entregas_de_aviso_de_passagem (organization_id, created_at desc);

drop trigger if exists trg_entregas_de_aviso_de_passagem_updated_at on public.entregas_de_aviso_de_passagem;
create trigger trg_entregas_de_aviso_de_passagem_updated_at
  before update on public.entregas_de_aviso_de_passagem
  for each row execute function public.fn_set_updated_at();

-- RLS e grants: os da 0292. `revoke all` PRIMEIRO, porque o default ACL do
-- baseline daria INSERT/UPDATE/DELETE a `authenticated`; leitura só `manager`;
-- escrita só pelo service role (o handler).
alter table public.entregas_de_aviso_de_passagem enable row level security;
revoke all    on public.entregas_de_aviso_de_passagem from anon, authenticated;
grant  select on public.entregas_de_aviso_de_passagem to authenticated;
grant  all    on public.entregas_de_aviso_de_passagem to service_role;

drop policy if exists leitura_entregas_de_aviso_de_passagem on public.entregas_de_aviso_de_passagem;
create policy leitura_entregas_de_aviso_de_passagem
  on public.entregas_de_aviso_de_passagem
  for select to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );

-- A PASSAGEM ANUNCIA NO BARRAMENTO. Toda linha nova de
-- `passagens_de_atendimento` — dos DOIS motores, que gravam por caminhos
-- diferentes (pg.Pool e supabase-js) — vira um `ai.handoff_recorded` no
-- `event_log`, consumido por `escalacao-aviso-de-passagem.v1`. Um gatilho, e não
-- um emit em cada chamador: são treze caminhos que passam conversa para humano,
-- e o décimo quarto nasceria sem o emit. Precedente: 0148 (`trg_agent_case_opened`).
-- O gatilho NÃO faz HTTP: só a linha no `event_log`.
create or replace function public.fn_emit_passagem_registrada()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.emit_event(
    'ai.handoff_recorded',
    'passagem_de_atendimento',
    new.id,
    jsonb_build_object(
      'passagem_id',     new.id,
      'conversation_id', new.conversation_id,
      'contact_id',      new.contact_id,
      'motivo_codigo',   new.motivo_codigo,
      'origem',          new.origem,
      'motor',           new.motor,
      'caso_id',         new.caso_id
    ),
    '{}'::jsonb,
    new.organization_id   -- SEMPRE de `new`: é o filtro de tenant
  );
  return null;            -- AFTER trigger: o retorno é ignorado
end;
$$;

-- As DUAS origens de EXECUTE (item 9 da doutrina de migrations).
revoke all     on function public.fn_emit_passagem_registrada() from public;
revoke execute on function public.fn_emit_passagem_registrada() from anon, authenticated;

drop trigger if exists trg_passagem_registrada on public.passagens_de_atendimento;
create trigger trg_passagem_registrada
  after insert on public.passagens_de_atendimento
  for each row
  execute function public.fn_emit_passagem_registrada();
