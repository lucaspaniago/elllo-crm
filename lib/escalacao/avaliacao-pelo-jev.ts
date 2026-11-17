/**
 * O TOM ÁSPERO AVALIADO PELO JEV (fork elllo, 16/11/2026).
 *
 * Pedido do dono: "Essa avaliação que a IA faz, eu queria que você usasse o Jev
 * para fazer isso." A avaliação da tolerância ao sentimento
 * (`./tolerancia-ao-sentimento.ts`, situação `tom_aspero`) passa a perguntar ao
 * Jev primeiro; o modelo de linguagem de hoje (`./avaliacao-da-passagem.ts`)
 * fica de reserva.
 *
 * ## Onde o Jev substitui, e onde não
 *
 * Só na situação `tom_aspero`. A nota de tom áspero mostra a hipótese e a
 * confiança, e é isso que o Jev devolve. O aviso de PASSAGEM mostra também
 * indícios, recomendação e contexto — texto que o Jev não escreve —, então ali
 * o modelo de hoje continua.
 *
 * ## As perguntas
 *
 *   - `hipotese` (Choice): brincadeira, irritação real, engano, **propaganda**
 *     ou outro. A propaganda é a opção nova: anúncio, oferta ou proposta
 *     comercial de alguém vendendo PARA a empresa;
 *   - `alguma_cabe` (Noul, o padrão "companion" da documentação do Jev):
 *     alguma das opções descreve bem a mensagem? Sem isto, um Choice escolhe
 *     sempre alguma coisa, mesmo quando nenhuma serve.
 *
 * ## Quando vale o Jev (`decidirPeloJev`)
 *
 *   - `alguma_cabe` ≥ 0,5 e a probabilidade da opção escolhida ≥ 0,6: vale.
 *   - Propaganda exige ≥ 0,85 E o Noul `cliente` ≤ 0,3: ela CALA (sem nota e
 *     sem passagem), e calar quem estava irritado de verdade é o erro caro.
 *     Medido com as mensagens reais de 16/11: sem o `cliente`, o Choice dava
 *     "propaganda" ≥ 0,9 a mensagens que o Noul de propaganda via em 0,35.
 *   - Abaixo disso, ou o Jev fora do ar: o modelo de hoje decide, como antes.
 *
 * ## O que vai para o Jev
 *
 * O aceite do administrador da organização (`settings.jev.aceite.alcance`)
 * diz o que pode sair do país. Com "cada mensagem, sozinha" (o aceite de hoje),
 * vai SÓ a mensagem áspera — sem o histórico, o Jev tende a ficar em dúvida
 * nas brincadeiras que dependem do contexto, e aí a reserva assume. Com o
 * aceite da conversa, vai também a transcrição curta.
 */
import type { Pergunta } from "@/lib/ai/decisao/cliente";
import { MENSAGEM_REDIGIDA } from "@/lib/lgpd/cascata";

import type { MensagemParaAvaliar, ResultadoDaAvaliacao } from "./avaliacao-da-passagem";
import { montarTranscricao } from "./avaliacao-da-passagem";
import type { ResultadoDoJevDoFork } from "./jev-do-fork";
import type { HipoteseDaPassagem } from "./vocabulario-do-aviso-de-passagem";

/** As opções do Choice — as hipóteses da passagem mais a propaganda. */
export const OPCOES_DO_TOM = ["brincadeira", "irritacao_real", "engano", "propaganda", "outro"] as const;
export type OpcaoDoTom = (typeof OPCOES_DO_TOM)[number];

export const MINIMO_PARA_VALER = 0.6;
export const MINIMO_PARA_PROPAGANDA = 0.85;
export const MINIMO_DE_ALGUMA_CABE = 0.5;
/** Acima disto, a mensagem parece de cliente, e a propaganda não cala. */
export const MAXIMO_DE_CLIENTE_NO_TOM = 0.3;

/** Teto da mensagem enviada ao Jev. */
const TETO_DA_MENSAGEM = 1_200;

export const PERGUNTAS_DO_TOM: Record<string, Pergunta> = {
  hipotese: {
    tipo: "choice",
    instrucao:
      "Uma mensagem de WhatsApp chegou a uma pequena empresa e o tom pareceu áspero. O que melhor explica a mensagem?",
    criterios: {
      brincadeira: "O remetente brincou, ironizou ou exagerou, sem irritação de verdade.",
      irritacao_real: "Há insatisfação real com a empresa e alguém da equipe precisa agir.",
      engano:
        "A aspereza foi um equívoco: mensagem mal lida, dirigida a outra pessoa, ou contexto que o atendimento não tinha.",
      propaganda:
        "É propaganda, anúncio, oferta ou proposta comercial de alguém vendendo um produto ou serviço PARA a empresa (o tom de alarme ou de urgência é do anúncio, não de um cliente insatisfeito).",
      outro: "Nenhuma das anteriores.",
    },
  },
  cliente: {
    tipo: "noul",
    instrucao:
      "Esta mensagem é de alguém interessado em comprar, contratar ou tirar dúvida sobre o que a empresa oferece, ou de alguém que já é cliente da empresa?",
  },
  alguma_cabe: {
    tipo: "noul",
    instrucao:
      "Alguma destas descreve bem a mensagem: brincadeira, irritação real com a empresa, engano, ou propaganda de alguém vendendo para a empresa?",
  },
};

/** O texto da mensagem áspera: a última fala do cliente com texto. */
export function mensagemAspera(mensagens: readonly MensagemParaAvaliar[]): string | null {
  const ultima = [...mensagens]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .find((m) => {
      if (m.direction !== "inbound") return false;
      const t = (m.body ?? "").trim() || (m.media_derived_text ?? "").trim();
      return t !== "" && t !== MENSAGEM_REDIGIDA;
    });
  if (!ultima) return null;
  const t = (ultima.body ?? "").trim() || (ultima.media_derived_text ?? "").trim();
  return [...t.replace(/\s+/g, " ")].slice(0, TETO_DA_MENSAGEM).join("");
}

/** O `state` do Jev. A transcrição só entra com o aceite da conversa. */
export function estadoDoTom(
  mensagens: readonly MensagemParaAvaliar[],
  alcance: "mensagem" | "conversa" | null,
): Record<string, unknown> | null {
  const mensagem = mensagemAspera(mensagens);
  if (!mensagem) return null;
  return {
    // Neutro de propósito: "o tom do CLIENTE" puxava o Noul `cliente` para
    // cima até no anúncio do ECAD (medido em 16/11).
    situacao: "Uma mensagem recebida no WhatsApp de uma pequena empresa teve tom áspero.",
    mensagem_recebida: mensagem,
    ...(alcance === "conversa" ? { conversa_recente: montarTranscricao(mensagens) } : {}),
  };
}

/** O que o Jev decidiu, ou `null` quando ele não decide (a reserva assume). */
export function decidirPeloJev(r: ResultadoDoJevDoFork): ResultadoDaAvaliacao | null {
  if (!r.ok) return null;
  const escolha = r.respostas.hipotese;
  const cabe = r.respostas.alguma_cabe;
  if (!escolha || escolha.tipo !== "choice") return null;
  if (!cabe || cabe.tipo !== "noul" || !(cabe.noul >= MINIMO_DE_ALGUMA_CABE)) return null;
  const opcao = escolha.escolha as OpcaoDoTom;
  if (!(OPCOES_DO_TOM as readonly string[]).includes(opcao)) return null;
  const p = escolha.probabilidades[opcao];
  if (typeof p !== "number" || !Number.isFinite(p)) return null;
  const minimo = opcao === "propaganda" ? MINIMO_PARA_PROPAGANDA : MINIMO_PARA_VALER;
  if (p < minimo) return null;
  if (opcao === "propaganda") {
    const cliente = r.respostas.cliente;
    if (!cliente || cliente.tipo !== "noul" || !(cliente.noul <= MAXIMO_DE_CLIENTE_NO_TOM)) return null;
  }
  const base = { confianca: Math.min(1, Math.max(0, p)), indicios: [], recomendacao: null, contexto: null };
  if (opcao === "propaganda") return { disponivel: true, hipotese: "outro", propaganda: true, ...base };
  return { disponivel: true, hipotese: opcao as HipoteseDaPassagem, ...base };
}
