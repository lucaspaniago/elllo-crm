/**
 * A PROPAGANDA QUE A FORMA NÃO DENUNCIA, VISTA PELO JEV (fork elllo, 16/11/2026).
 *
 * O silêncio de propaganda (`silenciarDisparoAutomatico`) só reconhecia o
 * disparo pela FORMA: modelo do WhatsApp Business, botões, lista. Propaganda em
 * texto comum, ou foto com legenda mandada por uma pessoa, passava, e a IA
 * respondia a um vendedor. Pedido do dono: "Ela diagnosticou que é uma
 * propaganda, ela deveria diagnosticar que é uma propaganda… pela imagem, pelo
 * texto, pela proposta."
 *
 * ## Quando pergunta
 *
 * Só nas MESMAS condições do silêncio de hoje (silêncio ligado, contato a quem
 * nunca escrevemos, contato não pessoal) e só com texto de pelo menos
 * `MINIMO_DE_CARACTERES`: um "oi" não é propaganda, e não vale meio segundo a
 * mais na primeira resposta ao cliente. Mensagem só com imagem, sem legenda,
 * segue o caminho de hoje (a descrição da imagem chega depois, por outro
 * worker, e a documentação do Jev ainda não dá imagem como pronta para
 * produção).
 *
 * ## Quando cala
 *
 * Dois Nouls numa chamada:
 *
 *   - `propaganda`: é anúncio, oferta ou proposta de alguém VENDENDO para a
 *     empresa?
 *   - `cliente`: é alguém querendo comprar, contratar ou tirar dúvida sobre o
 *     que a empresa oferece (ou que já é cliente)?
 *
 * Cala só com `propaganda` ≥ 0,9 E `cliente` ≤ 0,2. O erro caro é calar um
 * cliente — a IA não responderia e a conversa seria encerrada —, então a
 * régua é alta dos dois lados. O que for calado aparece no apanhado da manhã
 * seguinte, com o começo do texto: um engano é visto em um dia.
 */
import type { Pergunta } from "@/lib/ai/decisao/cliente";

import { probabilidadeDoNoul, type ResultadoDoJevDoFork } from "./jev-do-fork";

export const MINIMO_DE_CARACTERES = 30;
export const MINIMO_PARA_CALAR = 0.9;
export const MAXIMO_DE_CLIENTE = 0.2;
const TETO_DO_TEXTO = 1_500;

export const PERGUNTAS_DA_PROPAGANDA: Record<string, Pergunta> = {
  propaganda: {
    tipo: "noul",
    instrucao:
      "Esta mensagem é propaganda, anúncio, oferta ou proposta comercial de alguém tentando VENDER um produto ou serviço para a empresa que a recebeu?",
  },
  cliente: {
    tipo: "noul",
    instrucao:
      "Esta mensagem é de alguém interessado em comprar, contratar ou tirar dúvida sobre o que a empresa oferece, ou de alguém que já é cliente da empresa?",
  },
};

/** O texto que vale perguntar, ou `null` (curto demais, vazio). */
export function textoParaPerguntar(texto: string | null | undefined): string | null {
  const t = (texto ?? "").replace(/\s+/g, " ").trim();
  if ([...t].length < MINIMO_DE_CARACTERES) return null;
  return [...t].slice(0, TETO_DO_TEXTO).join("");
}

export function estadoDaPropaganda(texto: string): Record<string, unknown> {
  return {
    contexto:
      "Mensagem recebida no WhatsApp de uma pequena empresa, vinda de um número a quem a empresa nunca escreveu.",
    mensagem_recebida: texto,
  };
}

export interface DecisaoDaPropaganda {
  propaganda: boolean;
  probabilidade: number;
  cliente: number;
}

/** O que o Jev decidiu, ou `null` quando ele não respondeu (vale o caminho de hoje). */
export function decidirPropaganda(r: ResultadoDoJevDoFork): DecisaoDaPropaganda | null {
  if (!r.ok) return null;
  const propaganda = probabilidadeDoNoul(r.respostas, "propaganda");
  const cliente = probabilidadeDoNoul(r.respostas, "cliente");
  if (propaganda === null || cliente === null) return null;
  return {
    propaganda: propaganda >= MINIMO_PARA_CALAR && cliente <= MAXIMO_DE_CLIENTE,
    probabilidade: propaganda,
    cliente,
  };
}
