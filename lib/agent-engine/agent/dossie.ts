/**
 * O dossiê do contato (fork elllo, migration 9005) — o rapport que a Helô guarda de
 * cada pessoa, nas linhas de `lead_notes`, com CATEGORIA e FONTE.
 *
 * Pedido do dono (23/11/2026): "colocando na ficha de cada contato as informações
 * necessárias para fazer esse rapport... Não só cliente".
 *
 * ## A fonte é do código, nunca do modelo
 * O modelo escolhe a categoria (do que a nota fala). Quem CONTOU sai do caminho da
 * escrita: o agente na conversa do contato e o resumo do atendimento fechado gravam
 * `pessoa` (o que o próprio contato disse) ou `helo` (a observação dela sobre o jeito
 * e o tom); a tela e o mensageiro do dono gravam `lucas`. O schema da ferramenta
 * `save_lead_note` não tem o campo `fonte`: mandar um é erro de ensino (`.strict()`).
 *
 * ## O que o Lucas contou não vai ao contato
 * A nota `lucas` entra no prompt — é contexto para o tom e para conduzir —, marcada
 * "só para você". A garantia não é só o texto: a cerca `nota_do_lucas`
 * (`before-send.ts`) barra a resposta que repete um trecho de 5 palavras dela que a
 * conversa ainda não tem. O que já foi dito na conversa (o recado que o mensageiro
 * mandou, por exemplo) não é segredo e passa. `liberada` (o dono disse "pode usar com
 * ele") tira a nota da cerca.
 *
 * Sem I/O aqui: vocabulário, regra da fonte, desenho no prompt e a conta dos trechos.
 */

/** Do que a linha fala. Conferido contra a CHECK da 9005 por tests/unit/dossie-do-contato.test.ts. */
export const CATEGORIAS_DO_DOSSIE = ['conheceu', 'gostos', 'rotina', 'pendente', 'jeito', 'tom', 'fato'] as const;
export type CategoriaDoDossie = (typeof CATEGORIAS_DO_DOSSIE)[number];

/** Quem contou. Conferido contra a CHECK da 9005. */
export const FONTES_DO_DOSSIE = ['pessoa', 'helo', 'lucas'] as const;
export type FonteDoDossie = (typeof FONTES_DO_DOSSIE)[number];

/** O que cada categoria guarda — vai às instruções do agente e do resumo. */
export const SIGNIFICADO_DA_CATEGORIA: Record<CategoriaDoDossie, string> = {
  conheceu: 'como a pessoa chegou e como se conheceram',
  gostos: 'assuntos e gostos dela',
  rotina: 'a rotina dela (do negócio ou da vida, no que ela contou)',
  pendente: 'o que ficou para depois, dos dois lados',
  jeito: 'o que funciona com ela: direto ou detalhado, com ou sem brincadeira, áudio ou texto, horário',
  tom: 'o tom e as brincadeiras que nasceram entre vocês',
  fato: 'o resto que vale lembrar',
};

export function ehCategoriaDoDossie(v: unknown): v is CategoriaDoDossie {
  return typeof v === 'string' && (CATEGORIAS_DO_DOSSIE as readonly string[]).includes(v);
}

/**
 * A fonte de uma linha escrita pelo AGENTE (na conversa ou no resumo do atendimento):
 * jeito e tom são a observação dela; o resto é o que o contato disse. Nunca `lucas` —
 * o modelo, na conversa com o contato, só ouve o contato.
 */
export function fonteDaEscritaDoAgente(categoria: CategoriaDoDossie): 'pessoa' | 'helo' {
  return categoria === 'jeito' || categoria === 'tom' ? 'helo' : 'pessoa';
}

/** Uma linha do dossiê como o agente a vê no índice. */
export interface LinhaDoDossie {
  id: string;
  headline: string;
  categoria: CategoriaDoDossie;
  fonte: FonteDoDossie;
  liberada: boolean;
}

/** A nota que o contato NÃO pode ver repetida: contada pelo Lucas e não liberada. */
export function ehReservada(l: { fonte: FonteDoDossie | string; liberada: boolean }): boolean {
  return l.fonte === 'lucas' && !l.liberada;
}

/** O rótulo curto da linha no índice: `(gostos · contou a pessoa)`. */
export function rotuloDaLinha(l: Pick<LinhaDoDossie, 'categoria' | 'fonte' | 'liberada'>): string {
  const quem =
    l.fonte === 'pessoa'
      ? 'contou a pessoa'
      : l.fonte === 'helo'
        ? 'observação sua'
        : l.liberada
          ? 'contou o Lucas; pode usar com ela'
          : 'contou o Lucas; só para você, não repita a ela';
  return `(${l.categoria} · ${quem})`;
}

/** As linhas fixas que explicam o índice ao modelo (vão uma vez, antes das notas). */
export const LEGENDA_DO_DOSSIE =
  'Cada nota diz do que fala e quem contou. O que o Lucas contou é contexto para você ' +
  'conduzir e acertar o tom: não conte, não cite e não deixe transparecer à pessoa, ' +
  'nem diga que o Lucas contou, a não ser na nota marcada "pode usar com ela". ' +
  'O que uma pessoa contou nunca vai para outra.';

// ── a conta dos trechos (a cerca `nota_do_lucas`) ────────────────────────────

/** Tamanho do trecho: 5 palavras seguidas (a mesma régua da conferência do Hermes, D3). */
export const PALAVRAS_DO_TRECHO = 5;

/**
 * Palavras que não identificam nada: um trecho só delas ("o lucas pediu que você")
 * não é o segredo de ninguém. Um trecho com 4 ou mais destas não conta.
 */
const PALAVRAS_VAZIAS: ReadonlySet<string> = new Set(
  palavrasDoTexto(
    'a o e é de da do das dos que em no na nos nas um uma uns umas para pra pro por com sem se ' +
    'ao aos à às ele ela eles elas você voce vc eu me te lhe nos mais mas ou já ja não nao sim ' +
    'muito muita foi ser ter tem está esta estão estao isso isto esse essa este aquilo lá la aqui ' +
    'lucas helo helô pediu disse falou quer vai ver sobre como quando onde seu sua seus suas meu minha',
  ),
);

/** Minúsculas, sem acento, só letras e dígitos. */
export function palavrasDoTexto(texto: string): string[] {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length > 0);
}

function trechos(palavras: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + PALAVRAS_DO_TRECHO <= palavras.length; i++) {
    const janela = palavras.slice(i, i + PALAVRAS_DO_TRECHO);
    const vazias = janela.filter((p) => PALAVRAS_VAZIAS.has(p)).length;
    if (vazias >= PALAVRAS_DO_TRECHO - 1) continue;
    out.push(janela.join(' '));
  }
  return out;
}

/**
 * Os trechos das notas reservadas que a conversa AINDA NÃO TEM. O que já foi dito na
 * conversa (por qualquer lado) não é segredo: o recado que o mensageiro mandou à
 * pessoa está na nota e no histórico, e repeti-lo é normal.
 */
export function trechosReservados(
  notas: ReadonlyArray<{ headline: string; body: string; fonte: string; liberada: boolean }>,
  historico: ReadonlyArray<string>,
): Set<string> {
  const reservados = new Set<string>();
  for (const n of notas) {
    if (!ehReservada(n)) continue;
    for (const t of trechos(palavrasDoTexto(`${n.headline}\n${n.body}`))) reservados.add(t);
  }
  if (reservados.size === 0) return reservados;
  for (const m of historico) {
    for (const t of trechos(palavrasDoTexto(m))) reservados.delete(t);
  }
  return reservados;
}

/** Quantos trechos reservados o texto repete (0 = passa). */
export function trechosRepetidos(texto: string, reservados: ReadonlySet<string>): number {
  if (reservados.size === 0) return 0;
  let n = 0;
  for (const t of new Set(trechos(palavrasDoTexto(texto)))) if (reservados.has(t)) n++;
  return n;
}

/** O erro de ensino da cerca (sem o trecho: o modelo reescreve, o log não leva texto). */
export const ENSINO_DA_NOTA_DO_LUCAS =
  'Sua mensagem repete o que o Lucas contou sobre esta pessoa numa nota "só para você". ' +
  'Use a nota para entender e acertar o tom, mas não conte nem cite o que está nela, e não ' +
  'diga que o Lucas contou. Reescreva sem esse trecho, com o mesmo calor e o mesmo assunto; ' +
  'não troque por uma frase genérica de espera ("assim que eu tiver uma posição", "te falo por aqui").';
