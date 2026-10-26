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

### A4 — tolerância ao sentimento

Decisão do dono (26/10/2026), depois de um caso real: a irmã dele escreveu
"Oi, idiota" de brincadeira, a conversa passou na hora e o aviso de passagem
dizia "provável brincadeira (85%)". A sondagem anterior (uma pergunta neutra
separada, e a passagem SEMPRE depois; só quando a IA já tinha falado) foi
**removida**, e as mudanças que ela fazia em `lib/ai/handoff/orchestrator.ts` e
`lib/ai/elegibilidade/consulta-supabase.ts` voltaram ao upstream.

No lugar dela, `lib/escalacao/tolerancia-ao-sentimento.ts`, chamada pelo
`workers/ai-handoff-from-sentiment.handler.ts` antes do `triggerHandoff`. A cada
`ai.sentiment_alert`:

1. **Avalia** a conversa (`avaliarPassagem`, situação `tom_aspero` — sem linha de
   passagem, só as últimas mensagens). Não importa se a IA já falou.
2. **Sem irritação registrada na janela** (`config_aviso_de_caso.sondagem_minutos`,
   reinterpretada pela 9003; padrão 30 min): registra e **não passa**. A Helô
   (o turno normal do agente, que roda por conta própria) segue respondendo —
   a IA nunca é silenciada. Brincadeira ou engano → o dono recebe **uma nota
   curta** pelo mesmo número/conexão/espaçamento do aviso de caso:

   ```
   🔔 Acme: tom áspero, segui atendendo
   Cliente: Ana
   Mensagem: "Oi, idiota"
   Avaliação da IA: provável brincadeira (85%)
   Abrir: https://…/app/inbox?id=<conversa>
   ```

   Irritação real, outro ou avaliação indisponível → sem nota, só o registro.
3. **Segunda irritação na janela** (contada a partir da última): avalia de novo —
   agora com a resposta da IA e a réplica do cliente — e **passa só se for
   irritação real com confiança ≥ 80%** (`CONFIANCA_PARA_PASSAR`); o aviso de
   passagem ao dono (A1/A3) sai sozinho, com o contexto inteiro, e a chave sai da
   conversa. Senão segue atendendo, renova o registro e, em brincadeira/engano,
   manda a nota — **no máximo uma por conversa por janela**. Avaliação
   indisponível na segunda → passa (sem como confirmar a brincadeira).

**Pedido explícito de atendente e opt-out não mudam** — são outros gatilhos, que
não passam por este handler.

**A passagem de sempre (upstream, na hora)**: `sondagem_minutos = 0`; organização
sem linha em `config_aviso_de_caso`; sem contato; contato pessoal, bloqueado ou
anonimizado; grupo; humano já assumiu; conversa inelegível para a IA; e qualquer
erro antes de a irritação ficar registrada. Nesses casos a IA não está
atendendo — segurar a passagem deixaria o cliente sem ninguém.

**Estado**: `conversations.metadata.tolerancia_de_sentimento` (`versao` do CAS,
`primeira_em`, `ultima_em`, `evento_id`, `eventos` já contados, `hipotese`,
`confianca`, `nota_evento_id`/`nota_em`, `passagem_evento_id`). O evento
repetido pelo dreno não conta duas vezes, não reavalia e não reenvia a nota (a
nota é reivindicada antes do envio). ⚠️ O merge do `metadata` é ler-e-gravar:
uma escrita concorrente em outra chave do `metadata` da mesma conversa pode se
perder (ver o cabeçalho do arquivo).

A nota (`montarNotaDeTomAspero`, em `lib/escalacao/texto-do-aviso-de-passagem.ts`)
não tem linha de entrega nem tentativas: canal fora, teto diário ou envio
recusado = a nota não sai, e fica no log. Espaçamento do número = volta quando
libera. Botões: `ligado` e `aviso_de_passagem_ligado` da config valem para ela.

O aviso de passagem perdeu a linha "Sondagem: …" (não há mais pergunta separada).

Arquivos do upstream tocados por A (pequenos): `workers/ai-handoff-from-sentiment.handler.ts`
(chama a tolerância antes do `triggerHandoff`), `lib/event-log/register-handlers.ts`,
`lib/i18n/dicionario.ts` (um spread de `lib/i18n/aviso-de-passagem.ts`).

## Migrations do fork (faixa 9xxx)

| Arquivo | O quê |
|---|---|
| `supabase/migrations/20261025120000_9001_aviso_de_caso_em_partes.sql` | `entregas_de_aviso_de_caso.partes_enviadas` (0..20) |
| `supabase/migrations/20261025130000_9002_aviso_de_passagem_ao_suporte.sql` | `aviso_de_passagem_ligado`, `sondagem_minutos` (0..60), `entregas_de_aviso_de_passagem`, gatilho `trg_passagem_registrada` |
| `supabase/migrations/20261026120000_9003_tolerancia_de_sentimento.sql` | `sondagem_minutos` vira a janela da tolerância: default 10 → 30 e comentário da coluna (sem renomear; linhas existentes mantêm o valor) |

Os três blocos estão no `supabase/baseline.sql` **logo depois do bloco da 0687**
(e portanto antes da VARREDURA anon), com os rótulos
`-- ---- fork elllo: … (migration 9001) ----`, `… (migration 9002) ----` e
`… (migration 9003) ----`.

## Como rebasear

1. `git fetch` e `git rebase <tag ou main do upstream>` no ramo `elllo`.
2. Conflitos esperados e onde olhar:
   - `supabase/baseline.sql`: os três blocos do fork ficam colados ao fim do bloco
     da 0687. Se o upstream acrescentar blocos depois dele, mantenha os do fork
     **antes da VARREDURA anon**.
   - `workers/ai-handoff-from-sentiment.handler.ts`: poucas linhas, marcadas
     "Fork elllo" (o input do `triggerHandoff` vira a variável `passagem`).
   - `lib/escalacao/aviso-ao-suporte.ts`: passos 5 e 13–15. ⚠️ Se o upstream
     acrescentar um passo de prontidão do canal (8–12), espelhe-o em
     `aplicaAvisoDePassagem` (comentário "espelho dos passos 8–12; conferir ao
     rebasear").
3. Se o upstream mudar `ERROS_DA_ENTREGA_DE_AVISO`, o CHECK de
   `entregas_de_aviso_de_passagem.erro_codigo` precisa de uma migration 9xxx nova —
   `tests/invariants/aviso-de-passagem-ao-suporte.test.ts` reprova a divergência.
4. Rode os testes do fork: `tests/unit/aviso-de-caso-em-partes.test.ts`,
   `aviso-de-caso-envio-em-partes.test.ts`, `texto-do-aviso-de-passagem.test.ts`,
   `avaliacao-da-passagem.test.ts`, `aviso-de-passagem-ao-suporte.test.ts`,
   `tolerancia-ao-sentimento.test.ts`, `handoff-do-clima-com-tolerancia.test.ts`
   e `pnpm test:db`.

## Pendências conhecidas

- `tests/invariants/aviso-de-passagem-ao-suporte.test.ts` (invariante do fork)
  ainda prende o default antigo de `sondagem_minutos` (10); com a 9003 o default
  é 30 e o `test:db` reprova esse caso até a linha ser atualizada.
- `entregas_de_aviso_de_passagem` não tem política de retenção (a de
  `entregas_de_aviso_de_caso` tem, em `lib/retencao/politica.ts`).
- Não há tela para `aviso_de_passagem_ligado` e `sondagem_minutos` (a janela da
  tolerância): mudam por SQL.
