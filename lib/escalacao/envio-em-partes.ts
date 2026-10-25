/**
 * O ENVIO DE UM AVISO EM PARTES — uma parte por rodada do dreno (fork elllo).
 *
 * ## O que este arquivo é
 *
 * Duas funções puras, sem `env`, sem client e sem relógio próprio, que os dois
 * avisos à equipe usam para entregar uma mensagem fatiada:
 *
 *   - o aviso de CASO (`./aviso-ao-suporte.ts`), quando «Responder casos por
 *     este WhatsApp» está ligado — as partes vêm de `montarPartesDoAvisoDeCaso`;
 *   - o aviso de PASSAGEM (`./aviso-de-passagem-ao-suporte.ts`).
 *
 * ## Uma parte por invocação, e o handler NUNCA DORME
 *
 * Mandar sete mensagens seguidas no mesmo número atropelaria o espaçamento do
 * anti-ban (1,2 s + jitter entre mensagens do mesmo número), e esperar o
 * espaçamento dentro do handler atrasaria todos os eventos atrás dele no mesmo
 * tick. Por isso cada invocação manda UMA parte, registra o envio no
 * `pacing_ledger` e devolve ao chamador o instante em que a próxima pode sair —
 * que vira `retry_at` no dreno (o ramo de `retry` não conta tentativa).
 *
 * ## Quem guarda o progresso é o chamador
 *
 * O índice da próxima parte (`jaEnviadas`) é a coluna `partes_enviadas` da linha
 * de entrega. Esta função não sabe de banco: ela recebe o índice e devolve o
 * resultado do transporte. A falha do transporte SOBE (lança) de propósito —
 * quem decide entre tentar de novo e desistir é a regra do chamador, que conhece
 * os tetos de tentativa.
 */
import { logger } from "@/lib/logger";

import type { CanalDoAviso, PacingDoAviso, TransporteDoAviso } from "./aviso-ao-suporte";

/** A espera mínima entre duas partes quando o pacing já libera: um segundo. */
export const FOLGA_ENTRE_PARTES_MS = 1000;

export interface EnvioDeParte {
  transporte: TransporteDoAviso;
  pacing: PacingDoAviso;
  organizationId: string;
  canal: CanalDoAviso;
  channelSessionId: string;
  /** O endereço já resolvido pelo transporte. */
  to: string;
  partes: readonly string[];
  /** Quantas partes já saíram — é o índice da que sai agora. */
  jaEnviadas: number;
  agora: Date;
}

/**
 * Envia `partes[jaEnviadas]` e registra o envio no pacing.
 *
 * O registro no pacing FALHA ABERTO: a mensagem já está no celular de alguém, e
 * lançar aqui faria a rodada seguinte reenviar a mesma parte. Um envio que não
 * entrou no ledger é um efeito colateral perdido; uma parte em dobro é ruído no
 * WhatsApp da equipe.
 *
 * Lança quando o transporte recusa, ou quando o índice não aponta para parte
 * nenhuma (defeito do chamador, nunca estado de mundo).
 */
export async function enviarParte(entrada: EnvioDeParte): Promise<{ externalId: string | null }> {
  const parte = entrada.partes[entrada.jaEnviadas];
  if (typeof parte !== "string") {
    throw new Error(`parte_inexistente:${entrada.jaEnviadas}/${entrada.partes.length}`);
  }
  const resposta = await entrada.transporte.envia(
    entrada.organizationId,
    entrada.canal,
    entrada.to,
    parte,
  );
  try {
    await entrada.pacing.registraEnvio(entrada.organizationId, entrada.channelSessionId, entrada.agora);
  } catch (err) {
    logger.warn("[aviso-em-partes] envio não contabilizado no pacing", {
      organizationId: entrada.organizationId,
      channelSessionId: entrada.channelSessionId,
      causa: err instanceof Error ? err.message : String(err),
    });
  }
  return { externalId: resposta.externalId };
}

/**
 * Quando a PRÓXIMA parte pode sair.
 *
 * Pergunta ao pacing (que acabou de receber o envio desta parte): se ele recusa,
 * vale o `liberaEm` dele — espaçamento ou teto diário; se libera, agora + 1 s,
 * para a ordem das mensagens no celular não depender de dois envios caírem no
 * mesmo milissegundo. Falha ao perguntar também vira agora + 1 s: a próxima
 * rodada passa pelo pacing de novo antes de enviar, então errar aqui custa no
 * máximo uma rodada a mais.
 */
export async function proximoInstante(
  pacing: PacingDoAviso,
  organizationId: string,
  channelSessionId: string,
  agora: Date,
): Promise<Date> {
  const folga = new Date(agora.getTime() + FOLGA_ENTRE_PARTES_MS);
  try {
    const decisao = await pacing.decide(organizationId, channelSessionId, agora);
    if (!decisao.liberado && decisao.liberaEm.getTime() > folga.getTime()) return decisao.liberaEm;
    return folga;
  } catch (err) {
    logger.warn("[aviso-em-partes] pacing não respondeu; próxima parte em 1 s", {
      organizationId,
      channelSessionId,
      causa: err instanceof Error ? err.message : String(err),
    });
    return folga;
  }
}
