-- manifest: Fork elllo — tolerância ao sentimento: config_aviso_de_caso.sondagem_minutos deixa de ser a espera da sondagem (removida) e passa a ser a janela da tolerância, com padrão de 30 min.
-- ═══════════════════════════════════════════════════════════════════════════
-- 9003 (fork elllo) — a IA segue atendendo quando o tom do cliente fica áspero.
--
-- A sondagem da 9002 (uma pergunta neutra separada e, depois, a passagem
-- SEMPRE) foi removida por decisão do dono em 26/10/2026. No lugar dela,
-- `lib/escalacao/tolerancia-ao-sentimento.ts`: a primeira irritação só fica
-- registrada (e o dono recebe uma nota curta se a IA acha que foi brincadeira
-- ou engano); a conversa só passa para uma pessoa numa SEGUNDA irritação dentro
-- da janela, confirmada pela avaliação como irritação real com confiança de 80%
-- ou mais.
--
-- A janela é a coluna que já existe, `sondagem_minutos`, REINTERPRETADA — sem
-- renomear: o nome velho custa um comentário; o novo custaria mexer no
-- `fn_definir_aviso_de_caso` e nos leitores a cada rebase. 0 continua
-- desligando: em 0, a passagem por sentimento volta a ser a do upstream (na
-- hora). O CHECK 0..60 da 9002 fica como está.
--
-- Só o DEFAULT muda (10 → 30): linhas que já existem guardam o valor que têm.
-- Quem quer 30 numa linha antiga muda por SQL, como os outros botões do fork.
--
-- Faixa 9xxx = migrations do fork. Reaplicável: `set default` e `comment on`
-- são idempotentes; nenhum dado é tocado.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.config_aviso_de_caso
  alter column sondagem_minutos set default 30;

comment on column public.config_aviso_de_caso.sondagem_minutos is
  'Fork elllo (9003): janela da tolerância ao sentimento, em minutos (0..60; 0 = desligada, passagem na hora como no upstream). Uma segunda irritação dentro da janela, confirmada como irritação real (confiança >= 0,8), passa a conversa para uma pessoa; a primeira só é registrada. O nome vem da sondagem da 9002, removida.';
