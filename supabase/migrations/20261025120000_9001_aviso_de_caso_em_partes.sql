-- manifest: Fork elllo — guarda quantas partes do aviso de caso já saíram, para o aviso fatiado (resposta por WhatsApp ligada) mandar uma parte por rodada sem repetir nenhuma.
-- ═══════════════════════════════════════════════════════════════════════════
-- 9001 (fork elllo) — o aviso de caso em partes.
--
-- Com «Responder casos por este WhatsApp» ligado, o aviso sai em sete
-- mensagens (`montarPartesDoAvisoDeCaso`, lib/escalacao/texto-do-aviso.ts), uma
-- por rodada do dreno, respeitando o espaçamento do número. `partes_enviadas` é
-- o PROGRESSO: a rodada seguinte manda `partes[partes_enviadas]` e nunca
-- reenvia uma anterior. Desligado, o aviso é uma parte só e a coluna fica 0.
--
-- DIRC: não é calculável (o WhatsApp da equipe não é consultável), não existe
-- em outra tabela e não é ponteiro — é estado da própria entrega.
--
-- Faixa 9xxx = migrations do fork, fora da numeração do produto.
-- Reaplicável: `add column if not exists` + `drop constraint if exists`/`add`.
-- O default 0 preenche toda linha existente, então o CHECK não tem dado a
-- deduplicar antes (regra 8 da doutrina de migrations).
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.entregas_de_aviso_de_caso
  add column if not exists partes_enviadas smallint not null default 0;

alter table public.entregas_de_aviso_de_caso
  drop constraint if exists entregas_de_aviso_de_caso_partes_enviadas_check;
alter table public.entregas_de_aviso_de_caso
  add constraint entregas_de_aviso_de_caso_partes_enviadas_check
  check (partes_enviadas between 0 and 20);
