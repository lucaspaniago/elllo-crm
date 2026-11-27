-- manifest: Fork elllo — o acervo de peças físicas de uma loja de aluguel e venda: acervo_pecas (um código por peça, modelo, cor, tamanho, uso, preços de venda e locação, status, publicada, vezes alugada; espelhada em catalog_products pelo mesmo id), acervo_status_historico, acervo_reservas (retirada e devolução por data de evento) e acervo_previas (a prévia de 30 minutos que o gravar aplica uma vez só). Tudo só do servidor.
-- ═══════════════════════════════════════════════════════════════════════════
-- 9006 (fork elllo) — o acervo de peças pelo mensageiro do Hermes (acervo1).
--
-- Pedido do dono (26/11/2026) para a instalação de uma loja: cadastrar, publicar, mudar o
-- status e reservar peças pelo CRM, sempre em dois passos (prévia e gravar), atrás da chave
-- por organização `ACERVO_ORGS` (vazia = a rota responde 404 e estas tabelas ficam vazias).
-- A regra mora em `lib/acervo/acervo.ts`; a rota é `app/api/v1/acervo/route.ts`.
--
-- **`acervo_pecas`** — a peça física. O `id` é o mesmo da linha em `catalog_products`
-- (FK pelo id, `on delete cascade`): o catálogo guarda nome, preço,
-- fotos, `ativo` (= publicada) e `quantidade` (1 só quando disponível); aqui ficam modelo,
-- cor, tamanho, uso, os dois preços, status e `vezes_alugada`.
--
-- **`acervo_status_historico`** — cada troca de status (de, para, motivo).
--
-- **`acervo_reservas`** — a peça reservada para a data de um evento: retirada 1 dia antes,
-- devolução no primeiro dia útil depois (calculadas pelo código, no fuso da organização).
--
-- **`acervo_previas`** — o que a prévia mostrou, por 30 minutos. O gravar trava a linha,
-- aplica exatamente os `dados` e marca `gravada_em` (a segunda vez devolve o `resultado`).
--
-- As quatro: RLS ligada sem policy e sem grant a anon/authenticated — só o servidor lê e
-- grava. Reaplicável: `if not exists`, `drop … if exists` + `add`/`create`.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.acervo_pecas (
  id                  uuid not null,
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  codigo              text not null,
  modelo              text not null,
  cor                 text not null,
  tamanho             text not null,
  uso                 text not null,
  preco_venda_cents   bigint,
  preco_locacao_cents bigint,
  descricao           text,
  observacoes         text,
  status              text not null default 'disponivel',
  publicada           boolean not null default false,
  publicada_em        timestamptz,
  vezes_alugada       integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (id),
  unique (organization_id, id),
  unique (organization_id, codigo),
  -- Pelo id (a chave primária): o índice único (organization_id, id) do catálogo só nasce
  -- mais adiante no baseline. A organização igual nos dois é posta pelo código, na mesma transação.
  foreign key (id) references public.catalog_products(id) on delete cascade
);

alter table public.acervo_pecas drop constraint if exists acervo_pecas_uso_check;
alter table public.acervo_pecas add constraint acervo_pecas_uso_check
  check (uso in ('venda', 'locacao', 'ambos'));
alter table public.acervo_pecas drop constraint if exists acervo_pecas_status_check;
alter table public.acervo_pecas add constraint acervo_pecas_status_check
  check (status in ('disponivel', 'reservada', 'alugada', 'na_costureira', 'na_lavanderia', 'vendida'));
alter table public.acervo_pecas drop constraint if exists acervo_pecas_precos_check;
alter table public.acervo_pecas add constraint acervo_pecas_precos_check
  check (
    (preco_venda_cents is null or preco_venda_cents >= 0)
    and (preco_locacao_cents is null or preco_locacao_cents >= 0)
    and (uso = 'locacao' or preco_venda_cents is not null)
    and (uso = 'venda' or preco_locacao_cents is not null)
  );
alter table public.acervo_pecas drop constraint if exists acervo_pecas_textos_check;
alter table public.acervo_pecas add constraint acervo_pecas_textos_check
  check (
    char_length(codigo) between 1 and 40
    and char_length(modelo) between 1 and 120
    and char_length(cor) between 1 and 60
    and char_length(tamanho) between 1 and 30
    and (descricao is null or char_length(descricao) <= 1000)
    and (observacoes is null or char_length(observacoes) <= 2000)
    and vezes_alugada >= 0
  );

create index if not exists acervo_pecas_grupo_idx
  on public.acervo_pecas (organization_id, lower(modelo), lower(cor), lower(tamanho));

drop trigger if exists trg_acervo_pecas_updated_at on public.acervo_pecas;
create trigger trg_acervo_pecas_updated_at before update on public.acervo_pecas
  for each row execute function public.fn_set_updated_at();

alter table public.acervo_pecas enable row level security;
revoke all on public.acervo_pecas from anon, authenticated;
grant  all on public.acervo_pecas to service_role;

comment on table public.acervo_pecas is
  'Fork elllo (9006): a peça física do acervo de uma loja (um código por peça), espelhada em catalog_products (mesmo id, origem acervo). Só o servidor lê e grava, pela rota /api/v1/acervo.';

create table if not exists public.acervo_status_historico (
  id              uuid not null default gen_random_uuid() primary key,
  organization_id uuid not null,
  peca_id         uuid not null,
  de              text,
  para            text not null,
  motivo          text,
  created_at      timestamptz not null default now(),
  foreign key (organization_id, peca_id) references public.acervo_pecas(organization_id, id) on delete cascade
);

alter table public.acervo_status_historico drop constraint if exists acervo_status_historico_motivo_check;
alter table public.acervo_status_historico add constraint acervo_status_historico_motivo_check
  check (motivo is null or char_length(motivo) <= 500);

create index if not exists acervo_status_historico_peca_idx
  on public.acervo_status_historico (organization_id, peca_id, created_at desc);

alter table public.acervo_status_historico enable row level security;
revoke all on public.acervo_status_historico from anon, authenticated;
grant  all on public.acervo_status_historico to service_role;

comment on table public.acervo_status_historico is
  'Fork elllo (9006): cada troca de status de uma peça do acervo (de, para, motivo). Só o servidor lê e grava.';

create table if not exists public.acervo_reservas (
  id              uuid not null default gen_random_uuid() primary key,
  organization_id uuid not null,
  peca_id         uuid not null,
  data_evento     date not null,
  retirada        date not null,
  devolucao       date not null,
  cliente         text,
  observacoes     text,
  status          text not null default 'ativa',
  created_at      timestamptz not null default now(),
  cancelada_em    timestamptz,
  foreign key (organization_id, peca_id) references public.acervo_pecas(organization_id, id) on delete cascade
);

alter table public.acervo_reservas drop constraint if exists acervo_reservas_status_check;
alter table public.acervo_reservas add constraint acervo_reservas_status_check
  check (status in ('ativa', 'cancelada'));
alter table public.acervo_reservas drop constraint if exists acervo_reservas_datas_check;
alter table public.acervo_reservas add constraint acervo_reservas_datas_check
  check (
    retirada <= data_evento and data_evento < devolucao
    and (cliente is null or char_length(cliente) <= 200)
    and (observacoes is null or char_length(observacoes) <= 1000)
  );

create index if not exists acervo_reservas_peca_idx
  on public.acervo_reservas (organization_id, peca_id, retirada) where status = 'ativa';

alter table public.acervo_reservas enable row level security;
revoke all on public.acervo_reservas from anon, authenticated;
grant  all on public.acervo_reservas to service_role;

comment on table public.acervo_reservas is
  'Fork elllo (9006): a reserva de uma peça para a data de um evento: retirada um dia antes, devolução no primeiro dia útil depois. Só o servidor lê e grava.';

create table if not exists public.acervo_previas (
  id              uuid not null default gen_random_uuid() primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  acao            text not null,
  dados           jsonb not null,
  fotos           text[] not null default '{}'::text[],
  api_token_id    uuid,
  criada_em       timestamptz not null default now(),
  expira_em       timestamptz not null default (now() + interval '30 minutes'),
  gravada_em      timestamptz,
  resultado       jsonb
);

alter table public.acervo_previas drop constraint if exists acervo_previas_acao_check;
alter table public.acervo_previas add constraint acervo_previas_acao_check
  check (acao in ('cadastro', 'publicar', 'status', 'reserva', 'cancelar_reserva'));

create index if not exists acervo_previas_expira_idx
  on public.acervo_previas (expira_em) where gravada_em is null;

alter table public.acervo_previas enable row level security;
revoke all on public.acervo_previas from anon, authenticated;
grant  all on public.acervo_previas to service_role;

comment on table public.acervo_previas is
  'Fork elllo (9006): a prévia de uma escrita no acervo (vale 30 minutos). Gravar aplica exatamente o que a prévia mostrou, uma vez só. Só o servidor lê e grava.';
