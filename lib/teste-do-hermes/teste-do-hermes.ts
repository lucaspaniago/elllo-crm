/**
 * O MODO TESTE DO HERMES (fork elllo, teste1, 26/11/2026).
 *
 * Pedido do dono: "deixar de uma forma que acione a Helô do CRM" — no teste que ele faz
 * pelo WhatsApp com a Helô do Hermes, quem responde passa a ser o agente DE VERDADE do
 * CRM, e não o modelo do Hermes imitando o atendimento. Vale para qualquer instalação
 * (a Isaura, depois), nada aqui é preso a uma organização.
 *
 * ## Como
 *
 * Uma conversa de mentira dentro do CRM, e a PRÉVIA ASSISTIDA (`runAgentPreview`, kind
 * "assisted" — o núcleo do "Sugerir resposta") em cada fala:
 *
 * - **abrir**: contato "TESTE Hermes — <persona> (apagar)", etiqueta `teste-hermes`, SEM
 *   telefone, e uma conversa `archived` no canal da organização. Conversa arquivada não
 *   pede roteamento (`fn_request_channel_routing`, `fn_pedir_roteamento_na_mensagem`) e
 *   não aparece na caixa de entrada.
 * - **turno**: a fala entra como mensagem recebida `historico_importado` (os gatilhos de
 *   `messages` não emitem evento, não abrem demanda e não mexem na revisão do rascunho —
 *   migration 0760); roda a prévia com o agente PUBLICADO; cada candidato volta como
 *   mensagem de saída `historico_importado`, sem `external_id` (nada vai ao canal).
 * - **fechar**: conta os EFEITOS (caso, compromisso, job, retorno, evento, passagem,
 *   envio, item do apanhado — tem de dar zero), apaga traço da prévia, conversa e
 *   contato (as filhas vão em cascata), e conta a SOBRA (tem de dar zero).
 * - **varrer**: o pente — fecha todo teste com mais de `idadeMinutos` (padrão 120).
 *
 * ## Por que é seguro
 *
 * Na prévia nenhuma ferramenta de escrita executa: `applyPreviewPolicy` troca o `execute`
 * de tudo que não é leitura por PROPOSTA (`preview.ts`) e o turno não grava checkpoint nem
 * enfileira job (`inbound-turn.ts`, `if (preview)`). O que a prévia grava é a linha de
 * `agent_turn_traces` com `is_dry_run = true` (o fechar apaga) e a telemetria de
 * `knowledge_searches` (sem contato). O custo das chamadas fica em `llm_calls` (o contato
 * vira NULL ao apagar: o orçamento da organização continua contando).
 *
 * ⚠️ NÃO marque o contato de teste como pessoal: `is_personal` liga o STOP do envio
 * (`before-send.ts`) e a prévia vetaria toda resposta.
 *
 * Só apaga o que é de teste: etiqueta `teste-hermes` E nome com o prefixo E sem telefone.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { loadConversationAgentConfig } from '@/lib/agent-engine/agent/agent-config';
import { fusoDaOrganizacao } from '@/lib/agent-engine/agent/fuso-da-org';
import { runAgentPreview, type InboundTurnDeps } from '@/lib/agent-engine/agent/inbound-turn';
import { newPreviewResult } from '@/lib/agent-engine/agent/preview';
import { getLeadContext } from '@/lib/agent-engine/edge/crm/get-lead-context';

export const TAG_DO_TESTE = 'teste-hermes';
export const PREFIXO_DO_NOME = 'TESTE Hermes — ';
export const IDADE_DO_PENTE_MINUTOS = 120;
export const TETO_DO_TEXTO = 4000;

type Db = Pick<pg.Pool, 'query'>;

/** A chave por organização (`TESTE_DO_HERMES_ORGS`, uuids separados por vírgula). Vazia = desligado. */
export function testeDoHermesLigado(orgId: string, fonte: NodeJS.ProcessEnv = process.env): boolean {
  return (fonte.TESTE_DO_HERMES_ORGS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .includes(orgId);
}

/** O nome do contato de mentira: só a persona, curta, sem quebra de linha. */
export function nomeDoContatoDeTeste(persona?: string | null): string {
  const p = (persona ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${PREFIXO_DO_NOME}${p || 'cliente'} (apagar)`;
}

export interface TesteAberto {
  testeId: string;
  contatoId: string;
  canalId: string;
}

/** O teste da organização, se for de teste de verdade (etiqueta, prefixo e sem telefone). */
async function lerTeste(db: Db, orgId: string, testeId: string) {
  const { rows } = await db.query<{ conversa: string; contato: string; canal: string; criado: string }>(
    `select cv.id as conversa, ct.id as contato, cv.channel_session_id as canal, ct.created_at as criado
       from conversations cv
       join contacts ct on ct.id = cv.contact_id and ct.organization_id = cv.organization_id
      where cv.organization_id = $1 and cv.id = $2
        and $3 = any(ct.tags) and ct.display_name like $4 and ct.phone_number is null`,
    [orgId, testeId, TAG_DO_TESTE, `${PREFIXO_DO_NOME}%`],
  );
  return rows[0] ?? null;
}

export async function abrirTeste(
  db: Db,
  orgId: string,
  input: { persona?: string | null; canalId?: string | null; chave?: string | null },
): Promise<{ ok: true; teste: TesteAberto; repetido?: boolean } | { ok: false; codigo: 'sem_canal' }> {
  // A mesma chamada de novo (Idempotency-Key, o mensageiro repete quando o prazo dele estoura)
  // devolve o MESMO teste, sem criar outro contato.
  if (input.chave) {
    const { rows: ja } = await db.query<{ conversa: string; contato: string; canal: string }>(
      `select cv.id as conversa, ct.id as contato, cv.channel_session_id as canal
         from contacts ct join conversations cv on cv.contact_id = ct.id and cv.organization_id = ct.organization_id
        where ct.organization_id = $1 and $2 = any(ct.tags) and ct.source_metadata->>'teste_do_hermes_chave' = $3
        limit 1`,
      [orgId, TAG_DO_TESTE, input.chave],
    );
    if (ja[0]) return { ok: true, repetido: true, teste: { testeId: ja[0].conversa, contatoId: ja[0].contato, canalId: ja[0].canal } };
  }
  const { rows: canais } = await db.query<{ id: string }>(
    input.canalId
      ? 'select id from channel_sessions where organization_id = $1 and id = $2 and archived_at is null'
      : 'select id from channel_sessions where organization_id = $1 and archived_at is null order by created_at, id limit 1',
    input.canalId ? [orgId, input.canalId] : [orgId],
  );
  const canalId = canais[0]?.id;
  if (!canalId) return { ok: false, codigo: 'sem_canal' };
  const {
    rows: [ct],
  } = await db.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, tags, source_metadata)
     values ($1, $2, array[$3]::text[], jsonb_build_object('teste_do_hermes', true, 'teste_do_hermes_chave', $4::text)) returning id`,
    [orgId, nomeDoContatoDeTeste(input.persona), TAG_DO_TESTE, input.chave ?? null],
  );
  const {
    rows: [cv],
  } = await db.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id, status, service_revision, service_started_at)
     values ($1, $2, $3, 'archived', 1, now()) returning id`,
    [orgId, ct!.id, canalId],
  );
  return { ok: true, teste: { testeId: cv!.id, contatoId: ct!.id, canalId } };
}

function metadadoDoTeste(chave?: string | null): string {
  return JSON.stringify({ historico_importado: 'true', teste_do_hermes: true, ...(chave ? { teste_do_hermes_chave: chave } : {}) });
}

async function gravarFala(db: Db, orgId: string, t: { conversa: string; contato: string; canal: string }, direcao: 'inbound' | 'outbound', corpo: string, chave?: string | null) {
  await db.query(
    `insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status,
                           body, sent_via, sent_at, metadata, service_revision)
     values ($1, $2, $3, $4, 'text', $5, $6, $7, $8, clock_timestamp(), $9::jsonb, $10)`,
    [orgId, t.conversa, t.canal, t.contato, direcao, direcao === 'inbound' ? 'delivered' : 'sent', corpo,
     direcao === 'inbound' ? 'external_device' : 'ai', metadadoDoTeste(chave), direcao === 'inbound' ? 1 : null],
  );
}

export interface ResultadoDoTurno {
  respostas: string[];
  propostas: Array<{ ferramenta: string; argumentos: unknown }>;
  impedimentos: Array<{ code: string; message: string }>;
  custoCents: number;
  versaoDoAgente: string;
  /** A mesma fala de novo (Idempotency-Key): devolve as respostas já gravadas, sem rodar o modelo. */
  repetido?: boolean;
}

export async function turnoDoTeste(
  db: pg.Pool,
  deps: InboundTurnDeps,
  orgId: string,
  testeId: string,
  texto: string,
  chave?: string | null,
): Promise<{ ok: true; turno: ResultadoDoTurno } | { ok: false; codigo: 'teste_inexistente' | 'sem_agente' | 'sem_contexto' }> {
  const t = await lerTeste(db, orgId, testeId);
  if (!t) return { ok: false, codigo: 'teste_inexistente' };
  if (chave) {
    const { rows: ja } = await db.query<{ id: string }>(
      `select id from messages where organization_id = $1 and conversation_id = $2 and direction = 'inbound'
          and metadata->>'teste_do_hermes_chave' = $3 limit 1`,
      [orgId, t.conversa, chave],
    );
    if (ja[0]) {
      // A comparação fica no banco (microssegundos): o Date do JS perderia a precisão e pegaria a própria fala.
      const { rows: depois } = await db.query<{ body: string; direction: string }>(
        `select m.body, m.direction from messages m
          where m.organization_id = $1 and m.conversation_id = $2 and m.id <> $3
            and m.sent_at >= (select sent_at from messages where id = $3)
          order by m.sent_at, m.created_at, m.id`,
        [orgId, t.conversa, ja[0].id],
      );
      const respostas: string[] = [];
      for (const m of depois) {
        if (m.direction === 'inbound') break;
        respostas.push(m.body);
      }
      return { ok: true, turno: { respostas, propostas: [], impedimentos: [], custoCents: 0, versaoDoAgente: '', repetido: true } };
    }
  }
  const inicio = new Date();
  await gravarFala(db, orgId, t, 'inbound', texto.slice(0, TETO_DO_TEXTO), chave);
  const agent = await loadConversationAgentConfig(db, orgId, t.conversa, t.canal);
  if (!agent) return { ok: false, codigo: 'sem_agente' };
  const context = await getLeadContext(
    db,
    deps.crmCfg,
    { tenantId: orgId, leadId: t.contato, conversationId: t.conversa, fuso: await fusoDaOrganizacao(db, orgId) },
    { historyLimit: agent.historyMessageWindow, maxTokens: agent.historyTokenWindow, verImagens: agent.imageVisionEnabled ?? true },
  );
  if (!context.ok) return { ok: false, codigo: 'sem_contexto' };
  const { rows: notes } = await db.query(
    'select id::text as id, headline, body, categoria, fonte, liberada from lead_notes where organization_id = $1 and contact_id = $2 order by created_at, id',
    [orgId, t.contato],
  );
  const result = newPreviewResult();
  await runAgentPreview(deps, db, {
    kind: 'assisted',
    organizationId: orgId,
    runId: randomUUID(),
    agent,
    context,
    previous: null,
    notes: notes as never,
    contactId: t.contato,
    channelId: t.canal,
    result,
  });
  const respostas = result.candidates.map((c) => c.body).filter((b) => b.trim() !== '');
  for (const r of respostas) await gravarFala(db, orgId, t, 'outbound', r);
  const { rows: custo } = await db.query<{ cents: string | null }>(
    'select coalesce(sum(cost_cents), 0)::text as cents from llm_calls where organization_id = $1 and contact_id = $2 and created_at >= $3',
    [orgId, t.contato, inicio],
  );
  return {
    ok: true,
    turno: {
      respostas,
      propostas: result.proposals.map((p) => ({ ferramenta: p.tool, argumentos: p.arguments })),
      impedimentos: result.impediments.map((i) => ({ code: i.code, message: i.message })),
      custoCents: Number(custo[0]?.cents ?? 0),
      versaoDoAgente: agent.versionId,
    },
  };
}

/** O que NÃO pode existir para um contato de teste. Tudo zero, sempre. */
export interface EfeitosDoTeste {
  casos: number;
  compromissos: number;
  jobs: number;
  retornos: number;
  eventos: number;
  passagens: number;
  agendadas: number;
  envios: number;
  mensagensComEnvio: number;
  apanhado: number;
}

export async function efeitosDoTeste(db: Db, orgId: string, contato: string, conversa: string, desde: string): Promise<EfeitosDoTeste> {
  const { rows } = await db.query<Record<keyof EfeitosDoTeste, string>>(
    `select
       (select count(*) from agent_cases where organization_id = $1 and conversation_id = $3)::text as casos,
       (select count(*) from calendar_appointments where organization_id = $1 and (contact_id = $2 or conversation_id = $3))::text as compromissos,
       (select count(*) from job_queue where organization_id = $1 and (contact_id = $2 or payload::text like '%' || $3::text || '%'))::text as jobs,
       (select count(*) from cron_jobs where organization_id = $1 and contact_id = $2)::text as retornos,
       (select count(*) from event_log where organization_id = $1 and created_at >= $4::timestamptz
          and (entity_id in ($2, $3) or payload->>'contact_id' = $2::text or payload->>'conversation_id' = $3::text))::text as eventos,
       (select count(*) from passagens_de_atendimento where organization_id = $1 and (contact_id = $2 or conversation_id = $3))::text as passagens,
       (select count(*) from mensagens_agendadas where organization_id = $1 and (contact_id = $2 or conversation_id = $3))::text as agendadas,
       (select count(*) from send_ledger where organization_id = $1 and contact_id = $2)::text as envios,
       (select count(*) from messages where organization_id = $1 and conversation_id = $3
          and (external_id is not null or coalesce(metadata->>'historico_importado', '') <> 'true'))::text as "mensagensComEnvio",
       (select count(*) from itens_do_apanhado where organization_id = $1 and conversation_id = $3)::text as apanhado`,
    [orgId, contato, conversa, desde],
  );
  const r = rows[0]!;
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)])) as unknown as EfeitosDoTeste;
}

export function somaDosEfeitos(e: EfeitosDoTeste): number {
  return Object.values(e).reduce((a, b) => a + b, 0);
}

export async function fecharTeste(
  db: pg.Pool,
  orgId: string,
  testeId: string,
): Promise<{ ok: true; efeitos: EfeitosDoTeste; sobra: number; sobraDetalhe: Record<string, number> } | { ok: false; codigo: 'teste_inexistente' }> {
  const t = await lerTeste(db, orgId, testeId);
  if (!t) return { ok: false, codigo: 'teste_inexistente' };
  const efeitos = await efeitosDoTeste(db, orgId, t.contato, t.conversa, t.criado);
  const cliente = await db.connect();
  try {
    await cliente.query('begin');
    await cliente.query('delete from agent_turn_traces where organization_id = $1 and conversation_id = $2', [orgId, t.conversa]);
    await cliente.query('delete from conversations where organization_id = $1 and id = $2', [orgId, t.conversa]);
    await cliente.query(
      'delete from contacts where organization_id = $1 and id = $2 and $3 = any(tags) and display_name like $4 and phone_number is null',
      [orgId, t.contato, TAG_DO_TESTE, `${PREFIXO_DO_NOME}%`],
    );
    await cliente.query('commit');
  } catch (erro) {
    await cliente.query('rollback');
    throw erro;
  } finally {
    cliente.release();
  }
  const { rows } = await db.query<Record<string, string>>(
    `select (select count(*) from contacts where organization_id = $1 and id = $2)::text as contatos,
            (select count(*) from conversations where organization_id = $1 and id = $3)::text as conversas,
            (select count(*) from messages where organization_id = $1 and (conversation_id = $3 or contact_id = $2))::text as mensagens,
            (select count(*) from lead_notes where organization_id = $1 and contact_id = $2)::text as notas,
            (select count(*) from agent_turn_traces where organization_id = $1 and conversation_id = $3)::text as tracos,
            (select count(*) from ai_reply_drafts where organization_id = $1 and conversation_id = $3)::text as rascunhos`,
    [orgId, t.contato, t.conversa],
  );
  const sobraDetalhe = Object.fromEntries(Object.entries(rows[0] ?? {}).map(([k, v]) => [k, Number(v)]));
  const sobra = Object.values(sobraDetalhe).reduce((a, b) => a + b, 0);
  return { ok: true, efeitos, sobra, sobraDetalhe };
}

/** O pente: fecha todo teste da organização com mais de `idadeMinutos`. */
export async function varrerTestes(
  db: pg.Pool,
  orgId: string,
  idadeMinutos = IDADE_DO_PENTE_MINUTOS,
): Promise<{ fechados: number; sobra: number; efeitos: number }> {
  const { rows } = await db.query<{ conversa: string }>(
    `select cv.id as conversa
       from contacts ct join conversations cv on cv.contact_id = ct.id and cv.organization_id = ct.organization_id
      where ct.organization_id = $1 and $2 = any(ct.tags) and ct.display_name like $3 and ct.phone_number is null
        and ct.created_at < now() - make_interval(mins => $4::int)`,
    [orgId, TAG_DO_TESTE, `${PREFIXO_DO_NOME}%`, idadeMinutos],
  );
  let fechados = 0;
  let sobra = 0;
  let efeitos = 0;
  for (const r of rows) {
    const f = await fecharTeste(db, orgId, r.conversa);
    if (!f.ok) continue;
    fechados++;
    sobra += f.sobra;
    efeitos += somaDosEfeitos(f.efeitos);
  }
  return { fechados, sobra, efeitos };
}
