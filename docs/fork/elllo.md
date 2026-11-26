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

### C — silêncio de propaganda (disparo automático de empresa)

No ar desde 09/11/2026 (21:04 UTC) como `elllo-v1.102.0-silencio1` (app e worker; scheduler segue
`elllo-v1.102.0`), autorizado pelo Lucas fora da rotina semanal. PR #4 no fork.

Caso real (07/11/2026): uma empresa mandou um **modelo de marketing** do WhatsApp
Business ao número do dono. O CRM gravou uma imagem sem texto, abriu contato,
conversa e card, e a IA respondeu a um robô.

- Detecção (pura): `lib/waha/disparo-automatico.ts`. É disparo quando o
  `_data.message` (desembrulhado de `ephemeralMessage`, `viewOnceMessage*`,
  `editedMessage`…) tem `templateMessage`, `interactiveMessage`,
  `buttonsMessage` ou `listMessage`. As respostas (`buttonsResponseMessage`,
  `templateButtonReplyMessage`, `listResponseMessage`,
  `interactiveResponseMessage`) são uma pessoa tocando num botão e **não**
  contam. WEBJS é tolerado por `type`/`_data.isFromTemplate`, sem medição real.
- Sempre: o corpo vazio vira o texto legível do modelo (conteúdo, rodapé e
  botões numa linha `[SIM, CUPOM] [ARQUIVAR]`) e a mensagem ganha
  `metadata.disparo_automatico = { tipo, empresa }` (`empresa` =
  `verifiedBizName`; `texto` só quando o `body` do WAHA não é o texto inteiro).
  Os efeitos (opt-out, campanha, origem) continuam recebendo o `texto` de sempre.
- Silêncio (`lib/waha/silencio-de-disparo.ts`), quando o botão
  `settings.crm.silenciar_disparos_automaticos` não é `false` (padrão LIGADO,
  sem tela) **e** nunca houve mensagem de saída nossa (não falhada) ao contato
  **e** o contato não é pessoal: `aplicarEfeitosPosEntrada` não roda (sem card,
  sem `ai_agent.dispatch_requested`); o contato ganha a etiqueta `propaganda`
  (`fn_contato_adicionar_etiquetas` + `contact.tag_added`); a conversa é
  encerrada (`fn_service_status` → `closed`, soltando antes o atendente); a
  demanda do Radar do episódio fecha como `nao_procede`; card aberto anterior vai
  para a etapa de perdido por `encerraDemanda` (motivo `other`) — funil sem etapa
  de perdido deixa o card onde está, com log. Nenhum aviso.
- Upstream tocado: `lib/waha/ingest.ts` (`handleInbound`, linhas marcadas
  "Fork elllo"). Testes: `lib/waha/disparo-automatico.test.ts`,
  `silencio-de-disparo.test.ts`, `ingest-disparo-automatico.test.ts` (fixture
  anonimizada em `lib/waha/__fixtures__/disparo-template-noweb-2026.7.2.json`).

### D — a nota de tom áspero só diz "segui atendendo" quando a IA respondeu

No ar desde 16/11/2026 (23:01 UTC) dentro de `elllo-v1.102.0-jev1`, junto com o E,
autorizado pelo Lucas. PR #5 no fork, juntado ao `elllo` em avanço direto em 17/11/2026.

Ramo `elllo-nota-honesta` (16/11/2026), separável do resto: só
`lib/escalacao/tolerancia-ao-sentimento.ts`, `texto-do-aviso-de-passagem.ts` e
`lib/i18n/aviso-de-passagem.ts`. Sem migration.

Caso real (16/11/2026, conversa `2ed3b92e`): um disparo de propaganda (modelo
da "Vymber Rádio Indoor") foi silenciado no ingest — a IA não respondeu e a
conversa foi encerrada —, mas o clima mediu a mensagem (Haiku 0,15 < 0,3), o
alerta chegou à tolerância e o dono recebeu "🔔 …: tom áspero, segui
atendendo" com "provável brincadeira (75%)".

- Propaganda silenciada (`metadata.disparo_automatico` na mensagem **e** a
  etiqueta `propaganda` no contato) sai da tolerância antes de qualquer guarda:
  sem avaliação, sem nota e sem a passagem do upstream
  (`tolerancia:propaganda_silenciada`).
- A nota espera até 2 min por uma mensagem de saída da IA (`sent_via = 'ai'`)
  depois da mensagem do alerta, voltando a cada 20 s pelo `retry` do dreno (que
  não conta tentativa). Conversa encerrada não espera. Sem resposta, o cabeçalho
  vira "tom áspero, a IA não respondeu" e uma linha `Situação:` diz por quê.
- Testes: `tests/unit/tolerancia-ao-sentimento.test.ts` (o dublê agora traz a
  resposta da IA por padrão) e `texto-do-aviso-de-passagem.test.ts`.

### E — o Jev avalia, cala a propaganda e monta o apanhado das 7h

No ar desde 16/11/2026 (23:01 UTC) como `elllo-v1.102.0-jev1` (app, worker e scheduler; o
scheduler muda pelo cron do apanhado), com a migration 9004, autorizado pelo Lucas. PR #6 no
fork, juntado ao `elllo` em avanço direto em 17/11/2026.

Ramo `elllo-jev` (16/11/2026), por cima do D. Migration 9004. Pedido do dono:
usar o Jev na avaliação, calar propaganda, avaliar grupos sem responder e
mandar um apanhado só, na manhã seguinte.

- **A porta** (`lib/escalacao/jev-do-fork.ts`): toda pergunta sai por
  `decidirNoPonto` no ponto do clima (`sentiment_classify`) — a chave da
  organização, o consentimento (`settings.jev`: ligado, aceite, clima não
  desligado), a allowlist e o teto de 1,5 s do autor. Disjuntor do autor por
  propósito; linha em `llm_calls` (`elllo_jev_tom`, `elllo_jev_propaganda`,
  `elllo_jev_grupo`); teto de US$ 0,50 nas últimas 24 h
  (`settings.crm.jev_do_fork.teto_diario_usd`). Interruptores em
  `settings.crm.jev_do_fork.{avaliacao, propaganda, grupos, apanhado}`, todos
  ligados por padrão; só `false` desliga. Não é tarefa em `lib/ai/decisao/`:
  aquelas nunca calam, e estas calam por decisão do dono.
- **Tom áspero** (`avaliacao-pelo-jev.ts`, ligado na produção da tolerância):
  Choice brincadeira/irritação real/engano/propaganda/outro + Nouls `cliente` e
  `alguma_cabe`. Vale com `alguma_cabe` ≥ 0,5 e a opção ≥ 0,6; propaganda exige
  ≥ 0,85 e `cliente` ≤ 0,3, e então cala (`tolerancia:propaganda_pelo_jev`,
  sem nota, sem passagem, item no apanhado). Fora disso, o modelo de sempre.
  Com o aceite "mensagem", vai só a mensagem áspera; com "conversa", também a
  transcrição. O aviso de PASSAGEM segue com o modelo (precisa de indícios e
  recomendação, que o Jev não escreve).
- **Propaganda sem forma de disparo** (`propaganda-pelo-jev.ts`, no
  `silenciarDisparoAutomatico`): nas mesmas condições do silêncio (ligado, nunca
  escrevemos, não pessoal) e com texto ≥ 30 caracteres, Nouls `propaganda` e
  `cliente`; cala com ≥ 0,9 e ≤ 0,2, com os mesmos efeitos do disparo. Todo
  silêncio (forma ou Jev) entra em `itens_do_apanhado`. Upstream tocado:
  `lib/waha/ingest.ts` passa `texto: corpo` (linha "Fork elllo").
- **Grupos** (`grupos-pelo-jev.ts`, `grupo-pelo-jev.handler.ts`): o cron liga,
  uma vez por hora, todos os grupos do número que NUNCA teve linha na fila
  (`alternarGrupo` do autor, ator = o admin mais antigo; ⚠️ o primeiro reinicia
  a sessão do WAHA por segundos). Com o filtro aberto, grupo novo entra sozinho
  (`lib/grupos/ingest.ts`, linha "Fork elllo"); grupo com linha desligada
  continua fora. `ia_responde` nasce `false`: a IA nunca responde. O handler
  `elllo-grupo-pelo-jev.v1` (`message.group_received`) pergunta "vale o dono
  responder?" (≥ 0,7 → item no apanhado). Em 16/11 o número não estava em
  nenhum grupo (o WAHA devolveu 0).
- **Apanhado** (`apanhado-do-dono.ts`, cron `apanhado-do-dono` de 10 em 10 min
  no scheduler): entre 7h e 10h do fuso, reivindica os itens de antes da
  meia-noite (até 3 dias) com `incluido_em` e manda UMA mensagem pelo número da
  nota de tom áspero; sem itens, nada sai; envio que falha devolve os itens.
  Itens com mais de 30 dias são apagados (o texto nunca é guardado: só o
  ponteiro para a mensagem).
- Migration `9004` + bloco no `baseline.sql` depois do da 9003; prova de RLS em
  `tests/invariants/apanhado-do-dono.test.ts` (entrada em `PROVA_PROPRIA`).
- Desfazer sem imagem: `settings.crm.jev_do_fork = {"avaliacao": false,
  "propaganda": false, "grupos": false, "apanhado": false}`. Os grupos já
  ligados se desligam pela tela (Canais › Grupos).
- Testes: `tests/unit/jev-do-fork.test.ts`, os blocos novos de
  `lib/waha/silencio-de-disparo.test.ts` e de `tolerancia-ao-sentimento.test.ts`,
  `tests/unit/dispatcher-org-parada.test.ts` (o handler novo é "pula").

### F — a Helô lembra do contato: atendimentos anteriores e a mensagem citada

- **Atendimentos anteriores** (`lib/agent-engine/agent/abertura/atendimentos-anteriores.ts`):
  no turno, o resumo corrido do último checkpoint do contato FORA da fronteira
  atual entra sob "Memória do lead", rotulado como PASSADO (preço, prazo e
  combinado dali só valem se confirmados de novo). Sem fronteira, nada.
- **A mensagem que o cliente cita** (`abertura/mensagem-citada.ts`): quando o
  cliente usa "responder em cima", a citada entra logo depois da "Mensagem atual
  do cliente", em JSON (dado, nunca instrução): autor (cliente, você, atendente,
  automação, participante do grupo), hora, tipo de mídia, texto/legenda, conteúdo
  já derivado e se ela está no histórico acima. Fora da janela, vem pelo id
  (`reply_to_message_id`, mesma conversa); não achada, pela cópia do WhatsApp
  (`metadata.reply_to_body` / `reply_to_type`), rotulada como não conferida.
  Cobre a mensagem do job e as da mesma rajada (até 3); o rascunho assistido lê
  as recebidas depois da última nossa. Apagada não repete o texto; foto para
  agente que não vê imagens não leva a descrição.
  - Os classificadores do turno (passagem por palavra, opt-out, manipulação,
    estágio, roteador, Jev) NÃO recebem a citada: julgam o que o cliente disse
    agora, e a citada costuma ser fala nossa (o menu "falar com atendente"
    citado dispararia a passagem). O Jev só tem aceite para a mensagem sozinha.
  - Upstream tocado: `lib/waha/ingest.ts`, `citacaoDoPayload` + `midiaDaCitada`
    (tipo e legenda da citada que é mídia) e uma linha `reply_to_type` em cada
    INSERT, marcadas "elllo". `inbound-turn.ts` e `abertura/ritual.ts`: um
    parâmetro opcional a mais (`citacaoBlock`), vazio = abertura byte a byte a de antes.
  - Canal oficial (Meta): o ingest do autor não grava citação (só reação), então
    lá a citada não chega. Pendência.
- Testes: `abertura/atendimentos-anteriores.test.ts`, `abertura/mensagem-citada.test.ts`
  e os casos "elllo" de `lib/waha/ingest-citacao.test.ts`.

### G — o dossiê do contato (rapport), com quem contou

Pedido do dono (23/11/2026): "colocando na ficha de cada contato as informações
necessárias para fazer esse rapport... Não só cliente". A mesma essência da Helô do
Hermes (D0–D3); aqui a ficha é `lead_notes`.

- **Migration 9005:** `lead_notes` ganha `categoria` (conheceu, gostos, rotina,
  pendente, jeito, tom, fato), `fonte` (pessoa, helo, lucas) e `liberada`.
  - A fonte é do código, nunca do modelo. O agente grava `pessoa`, e `helo` só em
    jeito/tom (`fonteDaEscritaDoAgente`, `lib/agent-engine/agent/dossie.ts`). A tela
    grava `lucas`.
  - O default é `lucas`, a mais restrita: o mensageiro do dono grava pelo PostgREST
    sem saber da coluna.
  - Notas antigas: as "Recado do Lucas…" viram `pendente|lucas`, o resto `fato|pessoa`.
  - Também nascem `lead_dossie_flushes` (a marca do atendimento já resumido; RLS sem
    policy, só o servidor) e `fn_rapport_do_contato` (a leitura do mensageiro, só
    `service_role`, sem mensagem da conversa e sem os recados).
- **O que o Lucas contou não vai ao contato.** A nota `lucas` entra no prompt marcada
  "só para você"; a cerca nova `nota_do_lucas` (`before-send.ts`, cadeia v14) barra a
  resposta que repete um trecho de 5 palavras dela que a conversa ainda não tem.
  `liberada` ("pode usar com ele") a tira da cerca. Sem fail-safe que a desarme.
- **O agente não apaga a nota do Lucas** por `supersedes` (só consolida o que ele
  escreveu).
- **Ao fechar o atendimento** (`dossie-ao-fechar.ts`, laço do worker): o atendimento
  fechado há 10 min ou mais vai para o dossiê em notas por categoria, pelo mesmo
  `applySaveLeadNote` do flush. A instrução tira o que a pessoa contou de terceiros.
  Desligado por padrão: `DOSSIE_AO_FECHAR_INTERVAL_MS` (0 = OFF).
- **A tela:** a seção "Memória do contato" do painel lateral vira o dossiê
  (`components/inbox/DossieDoContato.tsx`), por categoria e com quem contou; o
  `manager` corrige, apaga, escreve e libera. Rotas `app/api/v1/contacts/[id]/dossie`
  (POST) e `.../dossie/[noteId]` (PATCH, DELETE), com auditoria sem o texto.
- **LGPD:** a anonimização já redige `headline`/`body` e zera o embedding (0494/0497/
  9043); categoria e fonte não são dado da pessoa. `fn_rapport_do_contato` ignora
  contato anonimizado e nota redigida.
- Testes: `tests/unit/dossie-do-contato.test.ts` (vocabulário contra a 9005, fonte do
  código, isolamento entre contatos, a cerca, a tela).

### H — o aviso de caso em linguagem natural ao dono (25/11/2026)

- **Opção por org:** `AVISO_DE_CASO_NATURAL_ORGS` (uuids). Ligada, o aviso de caso sai em 2 balões (a frase ao dono + o
  link), sem uuid nem RESPONDER/PERGUNTAR; o comando digitado continua aceito. Desligada (o padrão), o aviso é o de
  sempre, byte a byte (`tests/unit/aviso-de-caso-natural.test.ts`). Pelo modelo aprovado (9094), nada muda.
- **`open_human_case.aviso_ao_dono`** `{texto, acao_proposta, compromisso}` → `lib/escalacao/aviso-ao-dono.ts` grava
  LIMPO no `context_snapshot`: `aviso_ao_dono` (≤300), `aviso_acao`, `aviso_compromisso {inicio com fuso, duracao_min,
  titulo}`. Tolerante: parte inválida cai, o caso abre igual. **Contrato com a Helô do Hermes** (sessão 2): ela lê as três
  chaves, põe o compromisso na agenda no "pode" do Lucas e responde pelo RPC do RESPONDER. Mudar nome ou forma quebra o
  lado dela.
- Sem a frase: molde por tipo (`MOLDE_DO_AVISO_NATURAL`); atualização em "🔁 Fulano respondeu sobre «assunto»: …".
- **No rebase:** `texto-do-aviso.ts` (o `natural` antes do `respostaWhatsappHabilitada`), `aviso-ao-suporte.ts` (o
  `select` com `aviso_ao_dono:context_snapshot->>aviso_ao_dono` e o `natural: !modelo && …`), o executor do
  `open_human_case` em `inbound-turn.ts` (o snapshot recebe `camposDoAvisoAoDono`) e o teto do `open_human_case` em
  `peso-das-ferramentas.test.ts` (+280).
- Prompt da Helô do CRM v23 (`f01da4ba`): a missão do recado (indicação vira nota `pendente` "Indicação para o recado:",
  sem caso), o `aviso_ao_dono` e "nunca diga que não tem acesso à agenda". Fica no banco, não no código.

### I — sondar e missão: o recado que volta por outro número, sem cerca falada (26/11/2026)

- **Opção por org:** `SONDAR_E_MISSAO_ORGS` (uuids). Desligada (o padrão), o turno e a recusa de caso aberto são os de
  sempre, byte a byte (`tests/unit/recados-abertos.test.ts`, `tests/unit/caso-aberto-na-voz-da-helo.test.ts`).
- **Recados abertos no contato novo** (`lib/agent-engine/agent/abertura/recados-abertos.ts`): contato criado há até 14
  dias e sem nota "Recado do Lucas" recebe, junto do índice de notas, os recados do Lucas e as indicações dos OUTROS
  contatos dos últimos 14 dias (título da nota, nome, data; telefone mascarado; até 6). A leitura entra na trilha da
  origem do `Promise.all` do turno (o teto de 4 trilhas fica). Erro de leitura = bloco vazio.
- **Caso já aberto** (`human-cases.ts`, `recusaDeCasoAbertoNaVozDaHelo`): a mesma guarda (não dizer que alguém foi
  acionado, não prometer prazo), sem mandar dizer ao cliente "não consigo te dar um prazo".
- **Aviso natural**: o fail-safe "A IA prometeu algo e travou" vira "Prometi algo e travei" (só no ramo natural).
- **No rebase:** o terceiro item da trilha da origem em `inbound-turn.ts` e o `notesIndexBlock` com
  `recadosAbertosBlock`; o parâmetro `naVozDaHelo` de `recusaDeCasoAberto` e a chamada em `openCase`; a variável em
  `lib/agent-engine/env.ts` e no `.env.example`.
- **Contrato com a Helô do Hermes (sessão 2):** a nota de continuação no contato novo, título "Recado do Lucas
  (continuação de <data>): <assunto>", categoria `pendente`, corpo com `Assunto:` / `Mesma pessoa de:` / `Resultado:`.
- Prompt da Helô do CRM v24: sondar antes de se apresentar ("Oi, tudo bem? Em que posso ajudar?", variando), o recado
  que volta por outro número, o fecho da missão com UM caso (💰 e a pergunta de decisão), cercas silenciosas e menos
  balões; `inbound_debounce_ms` 20000 e `reply_min_interval_ms` 30000 na versão. A frase de passagem própria
  (`ai_agents.config.aviso_de_handoff`) troca "atendente humano", "equipe" e "fila". Tudo no banco, não no código.

### J — a voz mais solta: a cerca conta o que já foi dito, e as frases fixas sem cara de central (26/11/2026)

- **A cerca `nota_do_lucas`** (`lib/agent-engine/agent/ja-dito-ao-contato.ts`): "já dito" passa a ser tudo o que saiu a
  este contato (ou ele disse) em QUALQUER conversa dele ou de um contato juntado a ele (`is_merged_into`), em qualquer
  data, até 400 mensagens — não só a janela do turno. Só lê quando há nota reservada. Erro de leitura = lista vazia (a
  cerca fica mais rígida). Caso real: o recado ao Calebe saiu por um número, ele respondeu pelo outro, e a cerca vetava
  o nome do livro. Vale para todas as orgs (é a regra da própria cerca do fork).
- **O ensino da cerca** (`ENSINO_DA_NOTA_DO_LUCAS`, `dossie.ts`): reescrever com o mesmo calor e o mesmo assunto, sem a
  frase genérica de espera.
- **Caso aberto** (`FRASE_DA_HELO_EM_PEDIDO_SOBRE_CASO_ABERTO`): "Boa! Te conto quando tiver novidade." (sem o nome do
  Lucas como muleta), e "não repita a frase da pessoa" no ensino.
- **A resposta do dono a um caso** (`case-reply-turn.ts`, `instrucaoDoCasoConcluido`): atrás de `SONDAR_E_MISSAO_ORGS`,
  pede a resposta com as palavras da Helô, cobrindo tudo o que estava em aberto, recusa calorosa e com porta aberta (no
  lugar de "repasse … e encerre o assunto"). Desligada, a instrução de sempre, byte a byte.
- **Teste que quebra:** `tests/unit/frases-de-central.test.ts` (lista de frases proibidas: "uma posição do Lucas",
  "anotado", "me retornou", "seguir com a compra", "agradece a sua atenção"…).
- **No rebase:** o import de `ehReservada` e `jaDitoAoContato` e o `trechosDoLucas` em `inbound-turn.ts`; o parâmetro
  `naVozDaHelo` de `buildCaseReplyOpeningMessage` e a chamada no handler; as duas constantes em `dossie.ts` e
  `human-cases.ts`.
- Prompt da Helô do CRM v26 (no banco): "Como você soa no WhatsApp" (o Lucas só quando muda algo, sem bastidor, reagir
  ao conteúdo, cumprimento dosado, sem eco, ritmo, palavras de gente, um passo à frente), a apresentação quando o
  assunto tem a ver com o Lucas, e o repasse da resposta dele cobrindo a mesa inteira.

### K — a forma de três travas na voz da Helô, sem mexer na garantia (26/11/2026)

- **Opção:** a mesma `SONDAR_E_MISSAO_ORGS` (`GateContext.vozDaHelo`). Desligada, as travas e os ensinos de sempre.
- **`case_promise`** (`guardrails/voz-da-helo.ts`, `ensinoDePromessaSemCaso`): o veto e o destino obrigatório (caso ou
  retorno) ficam; o ensino manda agendar o retorno quando quem volta é ela, ou abrir o caso, e responder ao assunto sem
  contar que anotou nem que passou.
- **Volta do caso concluído** (`AgentTurnInput.decisaoDoDono`, posto pelo `case-reply-turn`): a nota do dono vira
  autorização do que a mensagem só repete — `semantic_promise` passa com `decisaoAutoriza` (os números iguais e metade
  das palavras de conteúdo; compra, pagamento, Pix e valor NUNCA); `horario_da_agenda` conta os dias e horários da nota
  como do contato (outro horário segue vetado). A saída do 3º veto de horário sai na voz da Helô.
- **Prévia:** `TurnPreview.decisaoDoDono` simula a volta de um caso.
- **No rebase:** os dois campos de `GateContext` e dos args da cadeia, o desvio no `semanticPromiseGate` e o `reason` da
  `casePromiseGate` em `before-send.ts`; `saidaNaVozDaHelo` em `horario-da-agenda.ts`; `decisaoDoDono` e `vozDaHelo` em
  `inbound-turn.ts` (entrada, `horariosDaAgenda()` e os dois contextos de envio); a entrada no `case-reply-turn`.
- **Nunca afrouxa:** nota "só para você", Pix fora do caso, família, agenda do dono, nome da agenda do celular, compra e
  pagamento, vocabulário interno.

## Migrations do fork (faixa 9xxx)

| Arquivo | O quê |
|---|---|
| `supabase/migrations/20261025120000_9001_aviso_de_caso_em_partes.sql` | `entregas_de_aviso_de_caso.partes_enviadas` (0..20) |
| `supabase/migrations/20261025130000_9002_aviso_de_passagem_ao_suporte.sql` | `aviso_de_passagem_ligado`, `sondagem_minutos` (0..60), `entregas_de_aviso_de_passagem`, gatilho `trg_passagem_registrada` |
| `supabase/migrations/20261026120000_9003_tolerancia_de_sentimento.sql` | `sondagem_minutos` vira a janela da tolerância: default 10 → 30 e comentário da coluna (sem renomear; linhas existentes mantêm o valor) |
| `supabase/migrations/20261116120000_9004_apanhado_do_dono.sql` | `itens_do_apanhado` (propaganda silenciada e grupo que vale resposta, só o ponteiro para a mensagem; `unique (organization_id, message_id, tipo)`; RLS leitura manager, escrita só servidor) |
| `supabase/migrations/20261123190000_9005_dossie_do_contato.sql` | `lead_notes.categoria`, `fonte` (default `lucas`) e `liberada`, com CHECKs; `lead_dossie_flushes` (só o servidor); `fn_rapport_do_contato` (só `service_role`) |

Os cinco blocos estão no `supabase/baseline.sql` **logo depois do bloco da 0687**
(e portanto antes da VARREDURA anon), com os rótulos
`-- ---- fork elllo: … (migration 9001) ----`, `… (migration 9002) ----` e
`… (migration 9003) ----`, `… (migration 9004) ----` e `… (migration 9005) ----`.

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
   - `lib/waha/ingest.ts`: em `handleInbound`, as linhas "Fork elllo" (o `corpo`
     com o texto do disparo e o `silenciarDisparoAutomatico` antes de
     `aplicarEfeitosPosEntrada`).
   - `lib/grupos/ingest.ts`: em `grupoLigado`, o bloco "Fork elllo" que liga o
     grupo novo (`ligarGrupoNovoNaEntrada`).
   - `lib/waha/ingest.ts`: `citacaoDoPayload`/`midiaDaCitada` e a linha
     `reply_to_type` dos dois INSERTs (marcadas "elllo").
   - `lib/agent-engine/agent/inbound-turn.ts`: o `Promise.all` dos blocos do
     sufixo (atendimentos anteriores + citação) e o `citacaoBlock` repassado ao
     `buildOpening` (turno inbound e prévia); `abertura/ritual.ts`: o último
     parâmetro de `buildOpeningMessage`.
   - `lib/event-log/register-handlers.ts` e `docker/scheduler/entrypoint.sh`:
     uma linha cada (o handler do grupo e o cron `apanhado-do-dono`).
3. Se o upstream mudar `ERROS_DA_ENTREGA_DE_AVISO`, o CHECK de
   `entregas_de_aviso_de_passagem.erro_codigo` precisa de uma migration 9xxx nova —
   `tests/invariants/aviso-de-passagem-ao-suporte.test.ts` reprova a divergência.
4. Rode os testes do fork: `tests/unit/aviso-de-caso-em-partes.test.ts`,
   `aviso-de-caso-envio-em-partes.test.ts`, `texto-do-aviso-de-passagem.test.ts`,
   `avaliacao-da-passagem.test.ts`, `aviso-de-passagem-ao-suporte.test.ts`,
   `tolerancia-ao-sentimento.test.ts`, `handoff-do-clima-com-tolerancia.test.ts`,
   `lib/waha/disparo-automatico.test.ts`, `lib/waha/silencio-de-disparo.test.ts`,
   `lib/waha/ingest-disparo-automatico.test.ts`, `tests/unit/jev-do-fork.test.ts`,
   `tests/unit/dispatcher-org-parada.test.ts` e `pnpm test:db` (com
   `tests/invariants/apanhado-do-dono.test.ts`).

## Pendências conhecidas

- `tests/invariants/aviso-de-passagem-ao-suporte.test.ts` (invariante do fork)
  ainda prende o default antigo de `sondagem_minutos` (10); com a 9003 o default
  é 30 e o `test:db` reprova esse caso até a linha ser atualizada.
- `entregas_de_aviso_de_passagem` não tem política de retenção (a de
  `entregas_de_aviso_de_caso` tem, em `lib/retencao/politica.ts`).
- Não há tela para `aviso_de_passagem_ligado` e `sondagem_minutos` (a janela da
  tolerância): mudam por SQL. Idem `settings.crm.silenciar_disparos_automaticos`.
- Silêncio de propaganda: o worker legado (`workers/ai-response-worker.ts`, só
  para `rag_bot` sem versão publicada) lê `message.received` e não passa por ele.
  O push de mensagem nova (`message.received`, emitido pelo banco) segue como em
  toda entrada. A importação de histórico (`lib/channels/historico/`) não lê o
  texto do modelo.
