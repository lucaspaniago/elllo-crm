/**
 * SAÍDA BLOQUEADA — a organização inteira não manda NADA para fora (fork elllo, saida1).
 *
 * Pedido do dono para a instalação de teste de uma loja (Martinica, etapa 0): o número dela
 * fica ligado ao CRM só para RECEBER; nenhuma mensagem, mídia, áudio, reação, boas-vindas,
 * campanha, aniversário, follow-up, aviso, apanhado ou envio pelo painel pode sair, e o
 * WhatsApp dela nunca pode ver "lida" nem "online" vindos daqui.
 *
 * ## Onde barra (o mais baixo possível, para nenhum caminho escapar)
 *
 * - `lib/waha/client.ts`: TODO método que escreve no WAHA (texto, mídia, vCard, reação,
 *   editar, apagar, visto, presença, status, recusa de chamada) começa por
 *   `barrarSaidaDaSessao`. Como todo envio pelo WhatsApp não oficial passa por esse
 *   cliente, nenhum caminho de cima (agente, painel, campanha, regra, aviso) escapa.
 * - `lib/agent-engine/edge/crm/session-reconciler.ts`: o redrive do watchdog, o único que
 *   fala com o WAHA sem o cliente, marca a mensagem `failed` com `saida_bloqueada`.
 * - Os outros canais (`lib/channels/adapters/*`): `send`, `sendReaction` e `sendTemplate`
 *   começam por `barrarSaidaDaOrg`.
 * - A sessão do WAHA nasce (e converge) com `noweb.markOnline = false`: sem "online".
 *
 * ## Como barra
 *
 * Lança `SaidaBloqueadaError`, uma `FalhaDeEnvioDoCanal` PERMANENTE: quem envia grava a
 * mensagem como `failed` (fica o registro) e não tenta de novo. A ENTRADA não muda: as
 * mensagens recebidas seguem chegando à caixa do painel.
 *
 * ## A chave
 *
 * `SAIDA_BLOQUEADA_ORGS` — uuids das organizações, separados por vírgula. Vazia (o padrão)
 * = nada muda, byte a byte. A sessão do WAHA é reconhecida pelo nome, que sempre começa
 * por `org_<8 primeiros hex do uuid>` (`lib/channels/nome-da-sessao.ts`); um prefixo que
 * coincida com outra organização da mesma instalação bloquearia as duas — o lado seguro.
 */
import { FalhaDeEnvioDoCanal } from "./falha-de-envio";

export const CODIGO_DA_SAIDA_BLOQUEADA = "saida_bloqueada";
export const MENSAGEM_DA_SAIDA_BLOQUEADA =
  "A saída desta organização está bloqueada: nada foi enviado.";

export class SaidaBloqueadaError extends FalhaDeEnvioDoCanal {
  readonly code = CODIGO_DA_SAIDA_BLOQUEADA;
  constructor(public readonly onde: string) {
    super(`${CODIGO_DA_SAIDA_BLOQUEADA}: ${MENSAGEM_DA_SAIDA_BLOQUEADA} (${onde})`, "permanente");
    this.name = "SaidaBloqueadaError";
  }
}

function orgsBloqueadas(fonte: NodeJS.ProcessEnv): string[] {
  return (fonte.SAIDA_BLOQUEADA_ORGS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
}

/** O começo do nome de TODA sessão do WAHA da organização (`org_<8 hex>`). */
export function prefixoDaSessaoDaOrg(orgId: string): string {
  return `org_${orgId.toLowerCase().replaceAll("-", "").slice(0, 8)}`;
}

export function saidaBloqueadaDaOrg(orgId: string | null | undefined, fonte: NodeJS.ProcessEnv = process.env): boolean {
  if (!orgId) return false;
  return orgsBloqueadas(fonte).includes(orgId.trim().toLowerCase());
}

export function sessaoDeOrgBloqueada(sessao: string | null | undefined, fonte: NodeJS.ProcessEnv = process.env): boolean {
  if (!sessao) return false;
  const s = sessao.trim().toLowerCase();
  return orgsBloqueadas(fonte).some((o) => {
    const p = prefixoDaSessaoDaOrg(o);
    return s === p || s.startsWith(`${p}_`);
  });
}

/** Lança `SaidaBloqueadaError` se a organização está com a saída bloqueada. */
export function barrarSaidaDaOrg(orgId: string | null | undefined, onde: string, fonte: NodeJS.ProcessEnv = process.env): void {
  if (saidaBloqueadaDaOrg(orgId, fonte)) throw new SaidaBloqueadaError(onde);
}

/** Lança `SaidaBloqueadaError` se a sessão do WAHA é de organização com a saída bloqueada. */
export function barrarSaidaDaSessao(sessao: string | null | undefined, onde: string, fonte: NodeJS.ProcessEnv = process.env): void {
  if (sessaoDeOrgBloqueada(sessao, fonte)) throw new SaidaBloqueadaError(onde);
}
