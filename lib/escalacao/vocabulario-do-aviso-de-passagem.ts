/**
 * O VOCABULÁRIO DO AVISO DE PASSAGEM AO DONO (fork elllo, migration 9002).
 *
 * O aviso de passagem é o irmão do aviso de caso: toda vez que o atendimento
 * automático passa uma conversa para uma pessoa (uma linha nova em
 * `passagens_de_atendimento`), o WhatsApp do dono recebe quem é o cliente, por
 * que passou, o trecho que disparou e o que a IA acha que aconteceu.
 *
 * A entrega reaproveita `STATUS_DA_ENTREGA_DE_AVISO` e
 * `ERROS_DA_ENTREGA_DE_AVISO` (`./vocabulario-do-aviso.ts`) — o CHECK de
 * `entregas_de_aviso_de_passagem` é o MESMO conjunto, e duas listas para o
 * mesmo transporte divergiriam no primeiro código novo. O que é PRÓPRIO deste
 * aviso mora aqui: a hipótese da avaliação.
 *
 * ⚠️ Módulo SEM import de `env`, de client e de rota: ele é lido pelo handler,
 * pela avaliação, pelo texto e pelo invariante.
 */

/** O evento que o gatilho da 9002 emite a cada passagem gravada. */
export const EVENTO_PASSAGEM_REGISTRADA = "ai.handoff_recorded";

/**
 * O que a IA acha que aconteceu na conversa que passou para uma pessoa.
 *
 * É o ÚNICO pedaço da avaliação que fica gravado (`entregas_de_aviso_de_passagem.
 * hipotese`): o texto que o modelo escreveu (indícios, recomendação, contexto)
 * vai no aviso e não volta para o banco — seria uma segunda cópia do relato do
 * cliente numa tabela que a cascata de LGPD não alcança.
 *
 *   - `brincadeira`    — o cliente brincou, ironizou ou exagerou sem irritação;
 *   - `irritacao_real` — há insatisfação de verdade e alguém precisa agir;
 *   - `engano`         — a passagem foi equívoco (mensagem mal lida, número
 *                        errado, contexto que a IA não tinha);
 *   - `outro`          — nenhuma das três explica.
 */
export const HIPOTESES_DA_PASSAGEM = ["brincadeira", "irritacao_real", "engano", "outro"] as const;
export type HipoteseDaPassagem = (typeof HIPOTESES_DA_PASSAGEM)[number];

/** A frase em PORTUGUÊS de cada hipótese — a chave do dicionário é o texto. */
export const FRASE_DA_HIPOTESE = {
  brincadeira: "brincadeira",
  irritacao_real: "irritação real",
  engano: "engano",
  outro: "outro motivo",
} as const satisfies Record<HipoteseDaPassagem, string>;
