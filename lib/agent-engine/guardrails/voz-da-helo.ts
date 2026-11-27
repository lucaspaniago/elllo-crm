/**
 * Fork elllo (voz2, 26/11/2026) — a FORMA de três travas na voz da Helô do CRM.
 *
 * Pedido do Lucas ("pode fazer", 26/11): afrouxar só a forma das travas que mais
 * endureciam a conversa (`helo-crm-travas-levantamento.md`), sem tocar a garantia:
 *
 *  - `case_promise`: a promessa sem destino continua vetada; muda o ENSINO — agende o
 *    retorno (você volta) ou abra o caso (precisa do Lucas) e responda ao assunto, sem
 *    contar que anotou nem que passou.
 *  - `semantic_promise` e `horario_da_agenda`, NA VOLTA DE UM CASO que o dono concluiu:
 *    a mensagem que só repete o que ele decidiu passa. NUNCA para compra ou pagamento,
 *    e nunca com horário que não está na decisão dele (a agenda dele não aparece).
 *
 * Tudo atrás de `SONDAR_E_MISSAO_ORGS` (quem chama decide). Sem I/O aqui.
 */

/** Compra, pagamento e dinheiro: a decisão do dono nunca libera promessa disso pela fala. */
const DINHEIRO = /compr|pag(a|o|ar|amento|uei|ou)|\bpix\b|transfer|boleto|dep[oó]sit|r\$|reais|\bvalor|pre[çc]o|desconto|cobr|parcel/i;

const VAZIAS = new Set([
  'que', 'para', 'pra', 'com', 'como', 'uma', 'umas', 'uns', 'dos', 'das', 'nos', 'nas', 'pelo', 'pela', 'pelos',
  'pelas', 'esse', 'essa', 'este', 'esta', 'isso', 'isto', 'aqui', 'ele', 'ela', 'eles', 'elas', 'você', 'voce',
  'vocês', 'voces', 'lucas', 'vai', 'vou', 'vão', 'vao', 'está', 'esta', 'estará', 'estara', 'será', 'sera', 'dia',
  'hora', 'horas', 'então', 'entao', 'também', 'tambem', 'muito', 'mais', 'sim', 'não', 'nao', 'tudo', 'certo',
]);

function semAcento(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function numeros(t: string): string[] {
  return [...t.matchAll(/\d+/g)].map((m) => String(Number(m[0])));
}

/** Raiz curta (5 letras) das palavras de conteúdo: "confirmou" e "confirme" se encontram. */
function raizes(t: string): Set<string> {
  return new Set(
    semAcento(t)
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 4 && !VAZIAS.has(w))
      .map((w) => w.slice(0, 5)),
  );
}

/**
 * A frase que a camada semântica marcou como promessa repete o que o dono decidiu?
 *
 * Passa só quando: não fala de dinheiro (nem a frase, nem a decisão abrir exceção);
 * todo número da frase (dia, mês, hora) está na decisão; e pelo menos metade das
 * palavras de conteúdo da frase aparece na decisão. Frase vazia ou sem conteúdo = não.
 */
export function decisaoAutoriza(frase: string | null | undefined, decisao: string | null | undefined): boolean {
  const f = (frase ?? '').trim();
  const d = (decisao ?? '').trim();
  if (f === '' || d === '') return false;
  if (DINHEIRO.test(semAcento(f))) return false;
  const nd = new Set(numeros(d));
  if (!numeros(f).every((n) => nd.has(n))) return false;
  const rf = raizes(f);
  if (rf.size === 0) return false;
  const rd = raizes(d);
  let iguais = 0;
  for (const r of rf) if (rd.has(r)) iguais++;
  return iguais * 2 >= rf.size;
}

/** O ensino da `case_promise` na voz da Helô: o destino continua obrigatório, a fala muda. */
export function ensinoDePromessaSemCaso(retornoDisponivel: boolean): string {
  return (
    'A mensagem promete que alguém volta a falar, mas nada está marcado. ' +
    (retornoDisponivel
      ? 'Se quem volta é você, agende com schedule_followup; se precisa do Lucas, abra o caso com open_human_case. '
      : 'Abra o caso com open_human_case. ') +
    'Depois responda ao assunto da pessoa, com o mesmo calor: não conte que anotou, registrou ou passou ' +
    'a alguém, e não troque por uma frase genérica de espera.'
  );
}

/** A saída do 3º veto de horário na voz da Helô (no lugar de "a equipe … te retornam por aqui"). */
export const SAIDA_DE_HORARIO_NA_VOZ_DA_HELO =
  'Não escreva nenhum dia nem horário nesta mensagem e não diga que está agendado. ' +
  'Diga, com as suas palavras e numa frase, que vai ver isso com o Lucas, e chame a ferramenta de passar para um humano.';
