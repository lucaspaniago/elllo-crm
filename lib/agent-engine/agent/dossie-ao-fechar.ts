/**
 * O dossiê ao fechar o atendimento (fork elllo, migration 9005).
 *
 * O flush da compaction só roda em conversa longa (gatilho de mensagens). A maioria dos
 * atendimentos é curta e fechava sem deixar nada no dossiê do contato. Este laço do
 * worker pega o atendimento que FECHOU (conversa com `service_closed_at`), resume o que
 * vale lembrar da pessoa em notas por categoria e marca (conversa, revisão) em
 * `lead_dossie_flushes` para nunca pagar o mesmo atendimento duas vezes.
 *
 * - **Quem grava** é `gravarDossieDoAtendimento` (`compaction.ts`), o mesmo caminho do
 *   flush: `applySaveLeadNote`, com a fonte posta pelo código (`pessoa`/`helo`) e o
 *   teto do índice de notas.
 * - **Só a conversa daquele contato** entra no transcript: a leitura é presa a
 *   (organização, conversa, contato) e à janela do atendimento. Nota de um contato
 *   nunca nasce da conversa de outro.
 * - **Fica de fora:** grupo, contato anonimizado, atendimento sem mensagem do contato,
 *   e o que fechou há menos de `FECHADO_HA_PELO_MENOS_MS` (ainda pode reabrir).
 * - **A marca vem ANTES da chamada ao modelo** (`insert … on conflict do nothing`): dois
 *   workers nunca resumem o mesmo atendimento. Falhou, fica `falhou` e não tenta de novo
 *   (best-effort, como o flush: o dossiê nunca derruba nada).
 * - **Desligado por padrão** (`DOSSIE_AO_FECHAR_INTERVAL_MS=0`): liga no `.env`, e
 *   voltar a 0 desliga sem trocar imagem.
 *
 * PII: o transcript e as notas vão ao modelo (é o ponto); o log leva só contagens.
 */
import type pg from 'pg';

import type { Logger } from '../obs/logger';
import type { LlmEdgeConfig } from '../edge/llm/run-model-call';
import { countPayloadTokens } from '../edge/crm/get-lead-context';
import { gravarDossieDoAtendimento, type TranscriptDoAtendimento } from './compaction';
import { getLeadNotesIndex, renderNotesIndex } from './lead-notes';

/** O atendimento fechado há menos que isto ainda pode reabrir: espera. */
export const FECHADO_HA_PELO_MENOS_MS = 10 * 60_000;
/** Teto do transcript que vai ao modelo (tokens, heurística chars/3,5). */
export const TRANSCRIPT_DO_DOSSIE_MAX_TOKENS = 6_000;
/** Teto de cada mensagem no transcript (caracteres). */
export const MENSAGEM_DO_DOSSIE_MAX_CHARS = 800;

export interface AtendimentoFechado {
  conversation_id: string;
  organization_id: string;
  contact_id: string;
  service_revision: number;
  inicio: Date | null;
  fim: Date;
}

/** Os atendimentos fechados na janela que ainda não foram para o dossiê. */
export async function atendimentosParaODossie(
  db: pg.Pool,
  opts: { limite: number; janelaMs: number },
): Promise<AtendimentoFechado[]> {
  const { rows } = await db.query<AtendimentoFechado>(
    `select c.id as conversation_id, c.organization_id, c.contact_id, c.service_revision,
            c.service_started_at as inicio, c.service_closed_at as fim
       from public.conversations c
       join public.contacts ct on ct.id = c.contact_id and ct.organization_id = c.organization_id
      where c.service_closed_at is not null
        and c.service_closed_at > now() - make_interval(secs => $2::float8 / 1000)
        and c.service_closed_at < now() - make_interval(secs => $3::float8 / 1000)
        and not c.is_group
        and not coalesce(ct.is_anonymized, false)
        and not exists (select 1 from public.lead_dossie_flushes f
                         where f.conversation_id = c.id and f.service_revision = c.service_revision)
        and exists (select 1 from public.messages m
                     where m.organization_id = c.organization_id and m.conversation_id = c.id
                       and m.direction = 'inbound'
                       and m.sent_at >= coalesce(c.service_started_at, '-infinity'::timestamptz)
                       and m.sent_at <= c.service_closed_at)
      order by c.service_closed_at
      limit $1`,
    [opts.limite, opts.janelaMs, FECHADO_HA_PELO_MENOS_MS],
  );
  return rows;
}

/**
 * O transcript do atendimento: só texto, do contato e nosso, dentro da janela do
 * atendimento, preso a (organização, conversa, contato). Corta pelas mais ANTIGAS até
 * caber no teto (o fim do atendimento é o que mais diz).
 */
export async function transcriptDoAtendimento(
  db: pg.Pool,
  a: AtendimentoFechado,
): Promise<TranscriptDoAtendimento> {
  const { rows } = await db.query<{ direction: string; sent_at: Date; body: string }>(
    `select m.direction, m.sent_at, m.body
       from public.messages m
      where m.organization_id = $1 and m.conversation_id = $2 and m.contact_id = $3
        and m.sent_at >= coalesce($4::timestamptz, '-infinity'::timestamptz)
        and m.sent_at <= $5::timestamptz
        and m.type <> 'reaction'
        and coalesce(m.body, '') <> ''
        and m.body <> '[mensagem anonimizada]'
      order by m.sent_at, m.id
      limit 400`,
    [a.organization_id, a.conversation_id, a.contact_id, a.inicio, a.fim],
  );
  let mensagens = rows.map((r) => ({
    quem: r.direction === 'inbound' ? ('contato' as const) : ('nos' as const),
    em: new Date(r.sent_at).toISOString(),
    texto: r.body.length > MENSAGEM_DO_DOSSIE_MAX_CHARS ? `${r.body.slice(0, MENSAGEM_DO_DOSSIE_MAX_CHARS)}…` : r.body,
  }));
  while (mensagens.length > 1 && countPayloadTokens(JSON.stringify(mensagens)) > TRANSCRIPT_DO_DOSSIE_MAX_TOKENS) {
    mensagens = mensagens.slice(1);
  }
  return {
    atendimento: { inicio: a.inicio ? new Date(a.inicio).toISOString() : '', fim: new Date(a.fim).toISOString() },
    mensagens,
  };
}

export interface RodadaDoDossie {
  atendimentos: number;
  notas: number;
  falhas: number;
}

/** Uma rodada: pega os atendimentos fechados e grava o dossiê de cada um. */
export async function runDossieAoFecharOnce(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  opts: { limite: number; janelaMs: number; model?: string; notesIndexMaxTokens: number; log: Logger },
): Promise<RodadaDoDossie> {
  const out: RodadaDoDossie = { atendimentos: 0, notas: 0, falhas: 0 };
  for (const a of await atendimentosParaODossie(db, opts)) {
    // A marca ANTES do modelo: quem não conseguir inserir, outro já pegou.
    const claim = await db.query(
      `insert into public.lead_dossie_flushes (conversation_id, service_revision, status)
       values ($1, $2, 'falhou') on conflict do nothing returning conversation_id`,
      [a.conversation_id, a.service_revision],
    );
    if (claim.rowCount === 0) continue;
    out.atendimentos++;
    let status: 'feito' | 'sem_notas' | 'falhou' | 'sem_conversa' = 'falhou';
    let notas = 0;
    try {
      const transcript = await transcriptDoAtendimento(db, a);
      if (transcript.mensagens.length === 0) {
        status = 'sem_conversa';
      } else {
        const atuais = renderNotesIndex(await getLeadNotesIndex(db, a.organization_id, a.contact_id));
        notas = await gravarDossieDoAtendimento(
          db,
          cfg,
          { tenantId: a.organization_id, leadId: a.contact_id },
          {
            transcript,
            notasAtuais: atuais,
            ...(opts.model !== undefined ? { model: opts.model } : {}),
            notesIndexMaxTokens: opts.notesIndexMaxTokens,
          },
          { log: opts.log },
        );
        status = notas > 0 ? 'feito' : 'sem_notas';
      }
    } catch (err) {
      out.falhas++;
      opts.log.warn('dossiê ao fechar: atendimento não resumido', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
    out.notas += notas;
    await db.query(
      `update public.lead_dossie_flushes set status = $3, notas_gravadas = $4
        where conversation_id = $1 and service_revision = $2`,
      [a.conversation_id, a.service_revision, status, notas],
    );
  }
  return out;
}

/** O laço do worker: dorme o intervalo, roda, repete. 0 = desligado (quem chama nem liga). */
export async function runDossieAoFecharLoop(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  opts: { intervalMs: number; limite: number; model?: string; notesIndexMaxTokens: number; log: Logger },
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, opts.intervalMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    if (signal.aborted) return;
    try {
      // Janela de 3 dias: cobre um worker parado num fim de semana, nunca o histórico.
      const r = await runDossieAoFecharOnce(db, cfg, { ...opts, janelaMs: 3 * 24 * 3_600_000 });
      if (r.atendimentos > 0) opts.log.info('dossiê ao fechar: rodada concluída', { ...r });
    } catch (err) {
      opts.log.error('dossiê ao fechar: rodada falhou', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
  }
}
