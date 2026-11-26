/**
 * Fork elllo — os RECADOS DO LUCAS em aberto, no turno de um contato NOVO.
 *
 * ## O defeito, medido em produção (25/11/2026)
 * O Lucas mandou a Helô falar com o Calebe (nota "Recado do Lucas" no contato do
 * número que o Fernando indicou). O Calebe respondeu de OUTRO número: o CRM criou um
 * contato novo, sem nota, e a Helô do CRM — que só lê as notas do próprio contato —
 * respondeu "Esse assunto eu não tenho registrado por aqui". A missão estava aberta
 * a um contato de distância.
 *
 * ## O que este bloco faz
 * Para um contato criado nos últimos 14 dias e que ainda não tem nota "Recado do
 * Lucas", o turno ganha a lista dos recados abertos dos OUTROS contatos (o título da
 * nota, que já resume o pedido e o assunto) e das indicações ligadas a eles, com o
 * nome do contato e a data. Sem telefone (mascarado) e sem corpo de conversa. O
 * prompt (v24) ensina: se a pessoa nova citar quem indicou, o nome ou o assunto, é a
 * mesma missão — ela grava a continuação NESTE contato e o bloco some sozinho no
 * turno seguinte (o contato passa a ter a nota).
 *
 * A fonte é o banco do próprio CRM (`lead_notes`): a Helô do CRM continua sem
 * acesso ao Hermes, de propósito.
 *
 * ## Atrás de opção
 * `SONDAR_E_MISSAO_ORGS` (uuids separados por vírgula). Fora da lista, o
 * turno é o de sempre, byte a byte (o bloco é '' e o índice de notas não muda).
 */
import type { Queryable } from '../../queue/queue';

/** Quantos dias para trás um recado conta como aberto. */
export const DIAS_DO_RECADO_ABERTO = 14;
/** Teto de linhas no bloco (o mais recente primeiro). */
export const TETO_DE_RECADOS = 6;
/** Teto de cada título no bloco. */
export const TETO_DO_TITULO_DO_RECADO = 220;

export function orgsDosRecadosAbertos(lista: string | null | undefined): Set<string> {
  if (typeof lista !== 'string') return new Set();
  return new Set(
    lista
      .split(/[\s,;]+/)
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x !== ''),
  );
}

export function sondarEMissaoLigado(tenantId: string, fonte: NodeJS.ProcessEnv = process.env): boolean {
  return orgsDosRecadosAbertos(fonte.SONDAR_E_MISSAO_ORGS).has(tenantId.toLowerCase());
}

/** Telefone vira "[telefone]": 8 dígitos ou mais, com espaço, ponto, traço ou parênteses no meio. */
export function semTelefone(texto: string): string {
  return texto.replace(/\+?\(?\d[\d\s().-]{6,}\d\)?/g, (trecho) =>
    trecho.replace(/\D/g, '').length >= 8 ? '[telefone]' : trecho,
  );
}

export interface LinhaDoRecadoAberto {
  contato: string | null;
  criada_em: string | Date;
  headline: string;
}

function dataCurta(d: string | Date): string {
  const x = typeof d === 'string' ? new Date(d) : d;
  return `${String(x.getUTCDate()).padStart(2, '0')}/${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const CABECALHO_DOS_RECADOS_ABERTOS =
  'Recados do Lucas em aberto, de OUTROS contatos (só para você; nunca cite a quem não tem a ver): ' +
  'se esta pessoa citar quem a indicou, o nome ou o assunto de um deles, é a mesma missão, mesmo vindo de outro número. ' +
  'Siga nela como na parte "Quando o Lucas te manda falar com alguém" e, antes de responder, grave neste contato a nota ' +
  '"Recado do Lucas (continuação de <data>)". Se não for nenhum deles, ignore esta lista.';

export function renderRecadosAbertos(linhas: readonly LinhaDoRecadoAberto[]): string {
  if (linhas.length === 0) return '';
  const itens = linhas.map((l) => {
    const titulo = semTelefone(l.headline.replace(/\s+/g, ' ').trim());
    const curto = titulo.length > TETO_DO_TITULO_DO_RECADO ? `${titulo.slice(0, TETO_DO_TITULO_DO_RECADO - 1)}…` : titulo;
    return `- ${dataCurta(l.criada_em)}, contato ${semTelefone(l.contato ?? '(sem nome)')}: ${curto}`;
  });
  return [CABECALHO_DOS_RECADOS_ABERTOS, ...itens].join('\n');
}

/**
 * O bloco do turno. '' quando a opção está desligada para a org, quando o contato não
 * é novo, quando ele já tem nota de recado ou quando não há recado aberto. Erro de
 * leitura também é '' (o bloco ajuda; nunca derruba o turno).
 */
export async function buildRecadosAbertosBlock(
  db: Queryable,
  tenantId: string,
  contactId: string,
  agora: Date,
  fonte: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (!sondarEMissaoLigado(tenantId, fonte)) return '';
  try {
    const desde = new Date(agora.getTime() - DIAS_DO_RECADO_ABERTO * 86_400_000).toISOString();
    const { rows: contato } = await db.query<{ novo: boolean; tem_recado: boolean }>(
      `select c.created_at >= $3::timestamptz as novo,
              exists (select 1 from lead_notes n where n.organization_id = $1 and n.contact_id = c.id
                       and n.headline ilike 'Recado do Lucas%') as tem_recado
         from contacts c where c.organization_id = $1 and c.id = $2`,
      [tenantId, contactId, desde],
    );
    if (!contato[0] || !contato[0].novo || contato[0].tem_recado) return '';
    const { rows } = await db.query<LinhaDoRecadoAberto>(
      `select coalesce(c.name, c.display_name) as contato, n.created_at as criada_em, n.headline
         from lead_notes n join contacts c on c.id = n.contact_id and c.organization_id = n.organization_id
        where n.organization_id = $1 and n.contact_id <> $2 and c.is_merged_into is null
          and n.created_at >= $3::timestamptz
          and (n.headline ilike 'Recado do Lucas%' or n.headline ilike 'Indicação para o recado%' or n.headline ilike '%indicou%')
        order by n.created_at desc limit $4`,
      [tenantId, contactId, desde, TETO_DE_RECADOS],
    );
    return renderRecadosAbertos(rows);
  } catch {
    return '';
  }
}
