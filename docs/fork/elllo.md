# Fork elllo — o que muda em relação ao upstream

Ramo `elllo`, baseado em `v1.87.0` (`dc921fa33`). Rebase semanal sobre o upstream:
o fork é desenhado para o **diff mínimo em arquivos do upstream** — o que é novo
mora em arquivos novos, e o que toca arquivo do upstream é pequeno e marcado com
"Fork elllo" no comentário.

## O que mudou, e por quê

### B — aviso de caso em partes

Com «Responder casos por este WhatsApp» (`config_aviso_de_caso.resposta_whatsapp_habilitada`)
**ligado**, o aviso de caso sai em sete mensagens, uma por rodada do dreno: o corpo,
`Abrir: <link>`, e cada instrução separada do seu comando (`RESPONDER <id> …`,
`PERGUNTAR <id> …`). No celular, o comando sozinho num balão é copiado com um toque;
num bloco de dez linhas, o UUID de 36 caracteres precisa ser selecionado à mão.

**Desligado, nada muda** — uma mensagem só, idêntica byte a byte ao texto de hoje
(decisão do dono; provado em `tests/unit/aviso-de-caso-em-partes.test.ts` e
`tests/unit/aviso-de-caso-envio-em-partes.test.ts`).

- Texto: `montarPartesDoAvisoDeCaso` em `lib/escalacao/texto-do-aviso.ts`.
- Envio: `lib/escalacao/envio-em-partes.ts` (puro) + passos 13–15 de
  `aplicaAvisoDeCaso` em `lib/escalacao/aviso-ao-suporte.ts`. O progresso fica em
  `entregas_de_aviso_de_caso.partes_enviadas`; o handler nunca dorme (cada parte
  devolve `retry` no instante que o pacing libera, ou agora + 1 s).
- A janela de reivindicação de 2 min só protege a **primeira** parte.
- Falha definitiva com partes já entregues: `enviado` + `erro_codigo = falha_no_envio`
  + `erro_detalhe = "incompleto k/n: …"`, sem item na Central (o aviso chegou) e com
  `metadata.incompleto` na auditoria `ai.case_alert_sent`.
- O teto de tentativas vale **por parte** (`tentativas` volta a 0 quando uma parte sai).

### A — aviso de passagem ao dono

**Aviso de passagem.** Toda linha nova de `passagens_de_atendimento` (dos dois
motores) emite `ai.handoff_recorded` (gatilho da migration 9002), consumido por
`escalacao-aviso-de-passagem.v1` (`lib/escalacao/aviso-de-passagem-ao-suporte.ts`).
O aviso vai pelo mesmo número e pela mesma conexão do aviso de caso, em duas
partes: o conteúdo e o link `/app/inbox?id=<conversa>`.

Pulos (decisão do dono): motivo `caso_escalado` ou caso que já teve aviso de caso;
contato pessoal ou anonimizado; grupo; alguém já assumiu; outra passagem da mesma
conversa avisada há menos de 30 min. Botão: `config_aviso_de_caso.aviso_de_passagem_ligado`
(padrão `true`).

O conteúdo leva o **trecho** (até 160 caracteres, sanitizado) da mensagem do cliente
que disparou — desvio consciente da regra do aviso de caso, documentado no cabeçalho
de `lib/escalacao/texto-do-aviso-de-passagem.ts` — e a **avaliação da IA**
(`lib/escalacao/avaliacao-da-passagem.ts`): hipótese (brincadeira / irritação real /
engano / outro), confiança, indícios, recomendação e contexto. A avaliação usa o
ponto `sentiment_classify` (modelo, orçamento e `llm_calls` do clima). Só a
hipótese e o hash do aviso ficam no banco.

A sondagem (A4: uma pergunta neutra separada antes de toda passagem por
sentimento) foi **removida** em 26/10/2026 por decisão do dono, com a reversão
das mudanças que ela fazia em `lib/ai/handoff/orchestrator.ts` e
`lib/ai/elegibilidade/consulta-supabase.ts`.

Arquivos do upstream tocados por A (pequenos): `lib/event-log/register-handlers.ts`,
`lib/i18n/dicionario.ts` (um spread de `lib/i18n/aviso-de-passagem.ts`).

## Migrations do fork (faixa 9xxx)

| Arquivo | O quê |
|---|---|
| `supabase/migrations/20261025120000_9001_aviso_de_caso_em_partes.sql` | `entregas_de_aviso_de_caso.partes_enviadas` (0..20) |
| `supabase/migrations/20261025130000_9002_aviso_de_passagem_ao_suporte.sql` | `aviso_de_passagem_ligado`, `sondagem_minutos` (0..60), `entregas_de_aviso_de_passagem`, gatilho `trg_passagem_registrada` |

Os dois blocos estão no `supabase/baseline.sql` **logo depois do bloco da 0687**
(e portanto antes da VARREDURA anon), com os rótulos
`-- ---- fork elllo: … (migration 9001) ----` e `… (migration 9002) ----`.

## Como rebasear

1. `git fetch` e `git rebase <tag ou main do upstream>` no ramo `elllo`.
2. Conflitos esperados e onde olhar:
   - `supabase/baseline.sql`: os dois blocos do fork ficam colados ao fim do bloco
     da 0687. Se o upstream acrescentar blocos depois dele, mantenha os do fork
     **antes da VARREDURA anon**.
   - `lib/escalacao/aviso-ao-suporte.ts`: passos 5 e 13–15. ⚠️ Se o upstream
     acrescentar um passo de prontidão do canal (8–12), espelhe-o em
     `aplicaAvisoDePassagem` (comentário "espelho dos passos 8–12; conferir ao
     rebasear").
3. Se o upstream mudar `ERROS_DA_ENTREGA_DE_AVISO`, o CHECK de
   `entregas_de_aviso_de_passagem.erro_codigo` precisa de uma migration 9xxx nova —
   `tests/invariants/aviso-de-passagem-ao-suporte.test.ts` reprova a divergência.
4. Rode os testes do fork: `tests/unit/aviso-de-caso-em-partes.test.ts`,
   `aviso-de-caso-envio-em-partes.test.ts`, `texto-do-aviso-de-passagem.test.ts`,
   `avaliacao-da-passagem.test.ts`, `aviso-de-passagem-ao-suporte.test.ts` e
   `pnpm test:db`.

## Pendências conhecidas

- **`tests/invariants/rls-completude-varredura.test.ts` reprova
  `entregas_de_aviso_de_passagem`** (tabela tenant-aware fora de `TABLES` e de
  `PROVA_PROPRIA`). A prova comportamental existe
  (`tests/invariants/aviso-de-passagem-ao-suporte.test.ts`), mas a entrada em
  `PROVA_PROPRIA` citando-a não foi feita porque os invariantes do upstream estão
  congelados no fork. Decisão pendente do dono: acrescentar a linha (um conflito
  pequeno por rebase) ou aceitar o vermelho no `test:db`.
- `entregas_de_aviso_de_passagem` não tem política de retenção (a de
  `entregas_de_aviso_de_caso` tem, em `lib/retencao/politica.ts`).
- Não há tela para `aviso_de_passagem_ligado` e `sondagem_minutos`: mudam por SQL.
