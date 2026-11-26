/**
 * O que JÁ FOI DITO a este contato, em qualquer conversa (fork elllo, voz1, 26/11/2026).
 *
 * A cerca `nota_do_lucas` (`guardrails/before-send.ts`) barra a resposta que repete um
 * trecho de uma nota "só para você" que a conversa ainda não tem. "A conversa" era só o
 * histórico do turno — a janela da conversa atual. Em 26/11 o recado do Lucas foi ao
 * Calebe por um número e ele respondeu pelo outro; depois da junção, a mensagem do recado
 * ficou na outra conversa, fora do histórico, e a cerca passou a tratar o nome do livro
 * como segredo: a Helô reescrevia sem a missão ("Assim que eu tiver uma posição do
 * Lucas, te falo por aqui.").
 *
 * O que saiu a esta pessoa (ou o que ela mesma disse), em qualquer conversa dela ou de um
 * contato juntado a ela, e em qualquer data, não é segredo. Esta leitura devolve esses
 * textos para a conta da cerca. Só roda quando há nota reservada (raro), com teto.
 *
 * Erro de leitura devolve [] — a cerca fica MAIS rígida, nunca mais frouxa.
 */
import type { Queryable } from '../queue/queue';

/** Quantas mensagens do contato entram na conta, das mais novas para as mais antigas. */
export const TETO_DO_JA_DITO = 400;

export async function jaDitoAoContato(db: Queryable, tenantId: string, contactId: string): Promise<string[]> {
  try {
    const { rows } = await db.query<{ body: string }>(
      `select m.body
         from messages m
        where m.organization_id = $1
          and m.contact_id in (
                select c.id from contacts c
                 where c.organization_id = $1 and (c.id = $2 or c.is_merged_into = $2))
          and m.body is not null and m.body <> ''
        order by m.created_at desc
        limit $3`,
      [tenantId, contactId, TETO_DO_JA_DITO],
    );
    return rows.map((r) => r.body);
  } catch {
    return [];
  }
}
