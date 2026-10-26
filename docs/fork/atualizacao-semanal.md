# Atualização semanal do fork elllo (roteiro)

Quem executa: a sessão do Claude Code aberta pela tarefa agendada semanal, na VPS do Lucas.
Quem aprova a implantação: **o Lucas, por mensagem explícita** ("pode implantar"). Sem isso, nada em
produção muda: as fases 0 a 5 só preparam.

Contexto em uma linha: o CRM em `crm.elllo.cloud` roda imagens do fork `lucaspaniago/elllo-crm`
(ramo `elllo` = mudanças próprias em commits isolados sobre uma release do autor
`melgarafael/DeskcommCRM`). Detalhes das mudanças e pontos de rebase: `docs/fork/elllo.md`.

## Regras que valem sempre

1. **Nunca rode `hostgator-setup-kit/update.sh`, nem o botão/aviso de "Atualizar" da tela do CRM.** Eles
   gravam no `.env` as imagens do AUTOR (`IMG_NS="ghcr.io/melgarafael"` em `_common.sh`) e as nossas
   mudanças somem em silêncio.
2. **Alvo = a última release ESTÁVEL publicada do autor** (`/repos/melgarafael/DeskcommCRM/releases/latest`),
   nunca a ponta da `main` nem uma tag sem release. Pré-release não conta.
3. **Espere a release ter pelo menos 48 h.** O autor costuma soltar correções logo depois; se a mais nova
   tem menos de 48 h, mire na anterior (se ela ainda for nova para nós) ou relate "aguardando".
4. **Imagens com etiqueta fixa por versão** (`elllo-vX.Y.Z`), nunca a etiqueta móvel `elllo` em produção.
   O cron `/etc/cron.d/docker-image-prune` apaga todo dia as imagens sem uso há mais de 24 h: voltar
   atrás é baixar de novo a etiqueta anterior, e ela precisa continuar existindo no ghcr.
5. **A VPS tem ~8 GB e roda produção.** Não rode a suíte inteira nem o typecheck completo aqui; rode os
   testes do projeto `cercas` e os arquivos do fork, e deixe o resto para o CI do GitHub.
6. **Banco de produção e troca de imagens só na fase 7**, depois do "pode implantar". O modo automático
   do Claude Code bloqueia essas ações; se bloquear mesmo com a autorização, peça ao Lucas para trocar o
   modo de permissão no seletor do app (para "Ask"/"Default") e aprove passo a passo.
7. **Na dúvida, pare e pergunte.** Conflito que muda comportamento visível ao Lucas, migration do autor que
   apaga/renomeia coluna ou tabela, variável nova obrigatória no `.env`, troca de versão do WAHA: tudo isso
   vai no relatório como decisão dele.
8. Commits com autor `Lucas Paniago <lucaspaniago10@gmail.com>` e a linha final
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Onde estão as coisas

| O quê | Onde |
|---|---|
| Clone de trabalho | `/home/claude/work/DeskcommCRM` (remotes: `origin` = autor, `fork` = `lucaspaniago/elllo-crm`) |
| Estado da última atualização | `/home/claude/work/elllo-estado.md` (versão base, etiquetas em produção, backups) |
| Token do GitHub (classic: repo, workflow, write:packages) | `/root/.config/elllo/github-token` (ler com `sudo`, nunca imprimir) |
| Instalação em produção | `/opt/deskcomm` (`.env`, compose: `docker-compose.prod.yml` + `docker-compose.traefik.yml`) |
| Banco | Supabase hospedado; conexão em `SUPABASE_DB_URL` do `/opt/deskcomm/.env` |
| Coisas vizinhas que NÃO podem quebrar | Hermes (`docker ps` → `hermes`), porteiro da família (`familia-broker.service`), cron do dreno (`crontab -l` do root) |

## Fase 0 — Pré-voo (só leitura)

- `df -h /`, `free -h`: pelo menos 10 GB livres e 1,5 GB de RAM disponível; senão, limpe imagens velhas
  antes (`docker image prune` só de etiquetas `lucaspaniago/*` que não estão em uso) e relate.
- `docker ps`: `deskcomm-app-1`, `deskcomm-worker-1`, `deskcomm-scheduler-1`, `deskcomm-waha-1`,
  `deskcomm-redis-1` de pé e `healthy` onde houver healthcheck. Anote a `org.opencontainers.image.revision`
  de app/worker/scheduler e confira com o estado.
- `curl -s -o /dev/null -w '%{http_code}' https://crm.elllo.cloud/` responde 200/302.
- Token válido: `GET https://api.github.com/user` com o token responde `lucaspaniago` e os escopos acima.
  Se faltar pouco para expirar (`github-authentication-token-expiration`), avise.
- Erros nas últimas 24 h: `docker logs --since 24h deskcomm-worker-1 | grep '"level":"error"'` (resuma).
- Se algo aqui estiver quebrado, **não atualize**: relate o problema e pare.

## Fase 1 — Há novidade?

- Release estável mais recente do autor e a data dela. Compare com a versão base do estado.
- Igual → relatório curto "nada novo do autor" + o resumo da saúde da fase 0. Fim.
- Nova, mas com menos de 48 h → relate "aguardando" (regra 3). Fim, a menos que haja uma anterior nova.

## Fase 2 — Ler o que mudou (antes de mexer em qualquer coisa)

Entre a tag base e a tag alvo (`git fetch origin --tags`):
- `CHANGELOG.md` e as notas de cada release do intervalo: resuma em linguagem simples para o Lucas.
- Migrations novas: `git diff --name-only base..alvo -- supabase/migrations`. Para cada uma, procure
  `drop table`, `drop column`, `rename`, `alter column ... type`, `truncate`, `delete from`. Qualquer
  uma dessas = decisão do Lucas e plano de volta escrito.
- Colisão de numeração com a nossa faixa `9xxx` (o autor usa `0NNN`; hoje não colide, mas confira).
- `.env.example` e `docker-compose*.yml`: variáveis novas obrigatórias, serviços novos, troca de `WAHA_IMAGE`
  (trocar o WAHA reinicia a sessão do WhatsApp: decisão do Lucas, janela de pouco movimento).
- `Dockerfile*`: só para saber se a montagem pode quebrar.
- Arquivos que o ramo `elllo` toca (lista em `docs/fork/elllo.md`): o autor mexeu neles? São os prováveis
  conflitos. Pontos quentes conhecidos:
  - `lib/escalacao/aviso-ao-suporte.ts` (envio em partes; e o aviso de passagem ESPELHA os passos 8–12 dele —
    se o autor mudou esses passos, replique em `aviso-de-passagem-ao-suporte.ts`);
  - `lib/escalacao/texto-do-aviso.ts`, `workers/ai-handoff-from-sentiment.handler.ts`,
    `lib/event-log/register-handlers.ts`, `lib/i18n/dicionario.ts` (o spread do fork);
  - `supabase/baseline.sql`: os blocos 9001/9002/9003 ficam logo depois do bloco da 0687 e ANTES da
    VARREDURA anon; confira que continuam nesse lugar e que o bloco que cria função segue antes da varredura;
  - `tests/invariants/rls-completude-varredura.test.ts` (a linha `entregas_de_aviso_de_passagem` em
    `PROVA_PROPRIA`) e `tests/unit/dispatcher-org-parada.test.ts` (o handler do fork na lista `PULA`).

## Fase 3 — Montar o candidato (sem mexer no ramo `elllo`)

```bash
cd /home/claude/work/DeskcommCRM
git fetch origin --tags && git fetch fork
BASE=vA.B.C   # versão base atual (estado)
ALVO=vX.Y.Z   # release alvo
git push fork "refs/tags/$ALVO" "$ALVO^{commit}:refs/heads/upstream-${ALVO#v}"
git checkout -B "elllo-$ALVO" elllo
git rebase --onto "$ALVO" "$BASE" "elllo-$ALVO"
```
- Conflito: resolva preservando as DUAS intenções (a do autor e a nossa). Releia o cabeçalho do arquivo do
  autor: ele costuma explicar o porquê. Se a resolução mudar o que o Lucas vê, pare e pergunte.
- Depois do rebase, confira `git diff "$ALVO".."elllo-$ALVO" --stat`: só os arquivos do fork e os
  pontos quentes, com tamanho parecido com o da semana anterior (anote no relatório).

## Fase 4 — Verificar

1. Local (leve): `pnpm install --frozen-lockfile`; `pnpm vitest run --project cercas`; os testes do fork
   (`tests/unit/aviso-de-caso-*`, `tests/unit/*passagem*`, `tests/unit/tolerancia-ao-sentimento.test.ts`,
   `tests/unit/handoff-do-clima-*`, `tests/unit/dispatcher-org-parada.test.ts`); eslint nos arquivos do fork.
2. CI no GitHub: `git push fork "elllo-$ALVO"` e abra um PR rascunho `elllo-$ALVO` → `upstream-${ALVO#v}`
   no fork (vitrine da semana). Espere `ci` verde, inclusive os invariantes de banco (pg15 e pg17).
   - Se o invariante parar em "não consegui saber qual é a última release publicada", falta a release
     espelho no fork: crie a release `$ALVO` no fork (só espelho, o Lucas autorizou esse tipo em
     26/10/2026; se o modo automático bloquear, peça).
3. Imagens: dispare `publish-image.yml` (workflow_dispatch) com `ref = elllo-$ALVO`. A etiqueta sai com o
   nome do ramo: `ghcr.io/lucaspaniago/{deskcommcrm,deskcomm-worker,deskcomm-scheduler}:elllo-$ALVO`.
4. Baixe as três na VPS (`docker pull`) e confira a `revision` = commit do candidato. Isto não muda produção.

## Fase 5 — Relatório para o Lucas (e esperar)

Em português simples, curto, no chat da sessão (e notificação):
- versão atual → versão nova, e o que o autor mudou que importa para ele;
- como foi o rebase (conflitos e como resolvi), testes e CI;
- migrations do autor (aditivas ou não), variáveis novas, mudança no WAHA;
- riscos, tempo fora do ar esperado (uns 2 min), janela sugerida (noite, pouco movimento) e como voltar;
- a pergunta: **"Posso implantar?"**. Sem resposta, não implante; na próxima semana, retome daqui.

## Fase 6 — (reservada) Ajustes pedidos pelo Lucas no relatório

Se ele pedir mudança, volte à fase 3/4 com o ajuste e reenvie o relatório.

## Fase 7 — Implantar (só depois do "pode implantar")

1. **Backup do banco**: `pg_dump` (imagem `postgres:17-alpine` via `docker run --rm`, com `SUPABASE_DB_URL`)
   para `/root/backups/crm-<data>-antes-$ALVO.dump` (formato custom). Confira que o arquivo existe e não
   está vazio. Sem backup bom, não siga.
2. **Cópia do `.env`**: `cp -p /opt/deskcomm/.env /opt/deskcomm/.env.bak-<data>-antes-$ALVO`. Anote no estado
   as etiquetas atuais de app/worker/scheduler e o commit de `/opt/deskcomm`.
3. **Código da instalação**: em `/opt/deskcomm`, `git fetch` do fork e `git checkout --detach <commit do
   candidato>` (preserva `.env` e arquivos não versionados; se houver mudança local versionada, pare). É o
   que dá ao compose e aos scripts a versão nova.
4. **Banco**: reaplique o `supabase/baseline.sql` do candidato do MESMO jeito que o `update.sh` do autor faz
   (função `reaplicar_baseline` em `hostgator-setup-kit/_common.sh`, via `url_do_schema`; ela filtra o ruído
   "already exists" e diz se o banco terminou limpo). Leia o trecho do `update.sh` (≈ linhas 320–640) da
   versão alvo antes, porque ele evolui. O baseline já inclui os blocos 9xxx do fork (idempotentes).
   Termine com `notify pgrst, 'reload schema';`. Banco que não terminou limpo = pare e relate.
5. **Imagens**: no `.env`, `APP_IMAGE`, `WORKER_IMAGE`, `SCHEDULER_IMAGE` = `ghcr.io/lucaspaniago/…:elllo-$ALVO`
   (as três da mesma versão). Variáveis novas obrigatórias da fase 2: acrescente agora.
6. `docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml up -d --no-deps app worker scheduler`
   (WAHA só se o Lucas aprovou a troca dele).
7. Se qualquer passo de 3 a 6 falhar: **volte** (seção abaixo) e relate.

## Fase 8 — Conferir (15 minutos olhando)

- app/worker/scheduler `healthy`, `revision` = candidato; site 200/302.
- Logs sem `"level":"error"` novos; `event-log drain: tick` aparecendo no worker; `dead` não subindo.
- WAHA entregando ao app: `docker logs deskcomm-waha-1` com `POST request was sent with status code: 200`.
- Uma mensagem recebida depois da troca foi processada (última `messages` inbound com turno/registro).
- `systemctl is-active familia-broker`, `docker ps` com o `hermes` de pé.
- Se algo estiver errado e não for trivial: volte.

## Voltar atrás

1. `cp -p /opt/deskcomm/.env.bak-<data>-antes-$ALVO /opt/deskcomm/.env`
2. `git -C /opt/deskcomm checkout --detach <commit anterior anotado no estado>`
3. `docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml up -d --no-deps app worker scheduler`
   (as imagens anteriores serão baixadas de novo pela etiqueta fixa).
4. Banco: o baseline é aditivo e a versão anterior convive com ele. Se a migration do autor foi destrutiva
   (só acontece com aprovação explícita da fase 2), o caminho é o backup do passo 7.1 — decisão do Lucas.

## Fase 9 — Fechar

- `git push --force-with-lease fork "elllo-$ALVO:elllo"` e `git branch -f elllo "elllo-$ALVO"` (o ramo
  `elllo` passa a ser a nova base). Feche o PR vitrine da semana anterior.
- Atualize `/home/claude/work/elllo-estado.md` (versão base, etiquetas, backup, data) e a memória
  `crm-fork-deskcomm`.
- Apague imagens `lucaspaniago/*` com mais de duas versões de idade; mantenha a anterior para voltar.
- Relatório final curto para o Lucas: no ar, o que mudou, o que observar nos próximos dias.
