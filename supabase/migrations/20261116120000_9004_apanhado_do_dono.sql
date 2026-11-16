-- manifest: Fork elllo — o apanhado das 7h ao dono: itens_do_apanhado (a propaganda silenciada e a mensagem de grupo que vale resposta, só por referência à mensagem), com unique (organization_id, message_id, tipo), RLS de leitura para manager e escrita só pelo servidor.
-- ═══════════════════════════════════════════════════════════════════════════
-- 9004 (fork elllo) — o que o dono recebe num apanhado só, na manhã seguinte.
--
-- Pedido do dono (16/11/2026): propaganda não ganha resposta nem aviso na
-- hora; mensagem de grupo nunca ganha resposta. As duas entram numa lista, e
-- às 7h do dia seguinte sai UMA mensagem com as propagandas de ontem e as
-- mensagens de grupo que valem a resposta dele.
--
-- Quem grava:  `lib/waha/silencio-de-disparo.ts` (propaganda silenciada, pela
--              forma do disparo ou pelo Jev) e
--              `lib/escalacao/grupo-pelo-jev.handler.ts` (grupo).
-- Quem lê:     `lib/escalacao/apanhado-do-dono.ts` (cron `apanhado-do-dono`).
--
-- **A linha NÃO guarda o texto.** Só o ponteiro para a mensagem: o apanhado lê
-- o corpo na hora de montar. Uma cópia do texto aqui sobreviveria à redação da
-- LGPD (`lib/lgpd/cascata`), que reescreve `messages.body`; apagada a
-- mensagem, o `on delete cascade` leva o item junto.
--
-- **`incluido_em` é a reivindicação.** O apanhado marca os itens com o dia
-- num UPDATE condicional (`incluido_em is null`) antes de enviar e desmarca se
-- o envio falhar: dois crons ao mesmo tempo dividem os itens em vez de mandar
-- os mesmos duas vezes. Por isso não há tabela de "apanhado enviado".
--
-- Reaplicável: `if not exists`, `drop … if exists` + `add`/`create`.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.itens_do_apanhado (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  tipo             text not null,
  origem           text not null,
  message_id       uuid not null references public.messages(id) on delete cascade,
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  -- A probabilidade que o Jev deu (propaganda ou "vale responder"); nula
  -- quando quem decidiu foi a forma do disparo, sem modelo.
  probabilidade    real,
  -- O dia LOCAL do apanhado que levou o item; nulo = ainda não foi.
  incluido_em      date,
  created_at       timestamptz not null default now()
);

-- Vocabulário fechado, conferido contra o TypeScript por
-- tests/invariants/apanhado-do-dono.test.ts (`TIPOS_DO_ITEM`, `ORIGENS_DO_ITEM`
-- em lib/escalacao/vocabulario-do-apanhado.ts).
alter table public.itens_do_apanhado
  drop constraint if exists itens_do_apanhado_tipo_check;
alter table public.itens_do_apanhado
  add constraint itens_do_apanhado_tipo_check
  check (tipo in ('propaganda', 'grupo'));

alter table public.itens_do_apanhado
  drop constraint if exists itens_do_apanhado_origem_check;
alter table public.itens_do_apanhado
  add constraint itens_do_apanhado_origem_check
  check (origem in ('disparo_automatico', 'jev'));

alter table public.itens_do_apanhado
  drop constraint if exists itens_do_apanhado_probabilidade_check;
alter table public.itens_do_apanhado
  add constraint itens_do_apanhado_probabilidade_check
  check (probabilidade is null or (probabilidade >= 0 and probabilidade <= 1));

-- A mesma mensagem entra uma vez por tipo: o webhook do provedor chega em
-- dobro (`message` e `message.any`) e o dreno repete evento.
create unique index if not exists itens_do_apanhado_unico
  on public.itens_do_apanhado (organization_id, message_id, tipo);

-- Leitor declarado: "os itens de ontem desta organização que ainda não foram".
create index if not exists itens_do_apanhado_pendentes_idx
  on public.itens_do_apanhado (organization_id, created_at)
  where incluido_em is null;

-- RLS e grants: os da 9002. `revoke all` PRIMEIRO (o default ACL do baseline
-- daria escrita a `authenticated`); leitura só `manager`; escrita só pelo
-- service role.
alter table public.itens_do_apanhado enable row level security;
revoke all    on public.itens_do_apanhado from anon, authenticated;
grant  select on public.itens_do_apanhado to authenticated;
grant  all    on public.itens_do_apanhado to service_role;

drop policy if exists leitura_itens_do_apanhado on public.itens_do_apanhado;
create policy leitura_itens_do_apanhado
  on public.itens_do_apanhado
  for select to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  );

comment on table public.itens_do_apanhado is
  'Fork elllo (9004): propaganda silenciada e mensagem de grupo que vale resposta, para o apanhado das 7h ao dono. Só o ponteiro para a mensagem (o texto é lido na hora, e a redação da LGPD vale). incluido_em = o dia local do apanhado que levou o item.';
