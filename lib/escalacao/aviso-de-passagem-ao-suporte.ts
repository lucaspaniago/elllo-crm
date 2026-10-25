/**
 * O WHATSAPP DO DONO É AVISADO DE TODA PASSAGEM PARA HUMANO (fork elllo).
 *
 * ## O que este arquivo é
 *
 * A REGRA do consumidor de `ai.handoff_recorded` — o evento que o gatilho da
 * migration 9002 emite a cada linha nova de `passagens_de_atendimento`, venha
 * ela de qualquer um dos dois motores. Pura e testável com relógio, banco e
 * transporte falsos, como `aplicaAvisoDeCaso` (`./aviso-ao-suporte.ts`), de quem
 * ela é irmã: o mesmo número de destino, a mesma conexão, o mesmo anti-ban, a
 * mesma reivindicação idempotente. O adapter de produção mora no fim, e a
 * ligação com o dispatcher em `./aviso-de-passagem-ao-suporte.handler.ts`.
 *
 * ## Quando NÃO avisa — decisão do dono
 *
 * O aviso sai em TODA passagem, exceto:
 *
 *   - motivo `caso_escalado`, ou passagem de um caso que já teve aviso de caso
 *     — a equipe já foi avisada pelo outro caminho;
 *   - contato pessoal, contato anonimizado, conversa de grupo;
 *   - alguém já assumiu (a passagem foi reconhecida, ou a conversa tem dono
 *     humano);
 *   - outra passagem da MESMA conversa foi avisada há menos de 30 minutos — o
 *     sentimento e o pedido explícito costumam chegar juntos, e dois avisos
 *     seguidos sobre a mesma conversa ensinam o dono a ignorar o canal.
 *
 * ## O que é igual ao aviso de caso, e por quê
 *
 * Os passos de prontidão do canal (arquivado, pausado, só mensagem aprovada,
 * desconectado, sem endereço público, transporte ausente, pacing, destino da
 * própria organização, destino inválido) são ESPELHO dos passos 8–12 de
 * `aplicaAvisoDeCaso`, sobre os MESMOS adapters exportados
 * (`createSupabaseAvisoDb`, `criarTransporteDoAviso`, `criarPacingDoCanal`,
 * `urlPublicaUsavel`). Espelho e não chamada porque lá eles estão costurados à
 * linha de `entregas_de_aviso_de_caso` e ao item da Central do caso.
 * ⚠️ **Conferir este espelho ao rebasear**: um passo novo de prontidão do aviso
 * de caso precisa do par aqui.
 *
 * O que é DIFERENTE: a falha definitiva grava `falhou` e vira log — sem item na
 * Central, que é do caso. O aviso de passagem é um conforto do dono; a
 * passagem em si já está na Central pelo orquestrador.
 *
 * ## Duas partes, uma por rodada, e o handler NUNCA DORME
 *
 * O conteúdo e o link (`montarPartesDoAvisoDePassagem`), entregues por
 * `./envio-em-partes.ts`. A avaliação da IA (`./avaliacao-da-passagem.ts`) roda
 * só quando a PRIMEIRA parte vai sair: o texto do modelo nunca é guardado — só a
 * hipótese entra na linha, junto com o hash do aviso inteiro.
 *
 * ## NENHUM DESFECHO É `error`
 *
 * Pelo mesmo motivo do aviso de caso: a instalação típica não tem aviso
 * configurado, e um `error` em "sem configuração" mataria o evento de toda
 * passagem de toda organização.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

import type { EventRow } from "@/lib/event-log/dispatcher";
import type { Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";

import type { MensagemParaAvaliar, ResultadoDaAvaliacao } from "./avaliacao-da-passagem";
import {
  ADIAMENTO_DO_CANAL_MS,
  ADIAMENTO_DO_DRENO_EM_REQUEST_MS,
  IDADE_MAXIMA_DO_EVENTO_MS,
  JANELA_DE_REIVINDICACAO_MS,
  TETO_ABSOLUTO_DE_TENTATIVAS,
  TETO_DE_TENTATIVAS_DE_ENVIO,
  TETO_DE_TENTATIVAS_DO_CANAL,
  VALIDADE_DA_ENTREGA_MS,
  mascara,
  type AvisoDb,
  type PacingDoAviso,
  type TransporteDoAviso,
} from "./aviso-ao-suporte";
import { enviarParte, proximoInstante } from "./envio-em-partes";
import type { MotivoDaPassagem } from "./passagem";
import {
  linkDaConversa,
  montarPartesDoAvisoDePassagem,
  type SondagemParaOAviso,
} from "./texto-do-aviso-de-passagem";
import { urlPublicaUsavel } from "./url-publica";
import type { ErroDaEntregaDeAviso, StatusDaEntregaDeAviso } from "./vocabulario-do-aviso";
import {
  EVENTO_PASSAGEM_REGISTRADA,
  type HipoteseDaPassagem,
} from "./vocabulario-do-aviso-de-passagem";

/** Outra passagem da mesma conversa avisada dentro desta janela segura o aviso. */
export const JANELA_ENTRE_AVISOS_DA_CONVERSA_MS = 30 * 60 * 1000;
/** Quantas mensagens o adapter lê para o trecho, a sondagem e a avaliação. */
export const MENSAGENS_LIDAS = 20;
/** Uma sondagem mais velha que isto, antes da passagem, não é desta passagem. */
export const ALCANCE_DA_SONDAGEM_MS = 2 * 60 * 60 * 1000;
/**
 * Folga depois do `criado_em` da passagem: o aviso ao lead do orquestrador sai
 * ANTES do insert, mas os relógios do app e do banco não são o mesmo relógio.
 */
const FOLGA_DO_INSTANTE_DA_PASSAGEM_MS = 5_000;

export interface ConfigDoAvisoDePassagem {
  organization_id: string;
  channel_session_id: string | null;
  telefone_destino: string;
  ligado: boolean;
  aviso_de_passagem_ligado: boolean;
  sondagem_minutos: number;
}

export interface PassagemDoAviso {
  id: string;
  organization_id: string;
  conversation_id: string;
  contact_id: string;
  caso_id: string | null;
  motivo_codigo: MotivoDaPassagem;
  criado_em: string;
  reconhecido_em: string | null;
}

export interface ConversaDoAvisoDePassagem {
  is_group: boolean;
  assignee_kind: string | null;
}

export interface ContatoDoAvisoDePassagem {
  nome: string | null;
  is_personal: boolean;
  is_anonymized: boolean;
}

export interface EntregaDoAvisoDePassagem {
  id: string;
  organization_id: string;
  passagem_id: string;
  destino: string;
  status: StatusDaEntregaDeAviso | string;
  tentativas: number;
  partes_enviadas: number;
  created_at: string;
  updated_at: string;
}

export interface PatchDaEntregaDePassagem {
  status?: StatusDaEntregaDeAviso;
  tentativas?: number;
  partes_enviadas?: number;
  erro_codigo?: ErroDaEntregaDeAviso | null;
  external_id?: string | null;
  corpo_hash?: string | null;
  hipotese?: HipoteseDaPassagem | null;
  enviado_em?: string | null;
}

export interface AvisoDePassagemDb {
  carregaConfig(orgId: string): Promise<ConfigDoAvisoDePassagem | null>;
  carregaPassagem(orgId: string, passagemId: string): Promise<PassagemDoAviso | null>;
  carregaConversa(orgId: string, conversationId: string): Promise<ConversaDoAvisoDePassagem | null>;
  carregaContato(orgId: string, contactId: string): Promise<ContatoDoAvisoDePassagem | null>;
  /** O caso desta passagem já teve aviso de caso (pendente ou enviado)? */
  casoJaAvisado(orgId: string, casoId: string): Promise<boolean>;
  /** Outra passagem DESTA conversa tem aviso pendente ou enviado desde `desde`? */
  outraPassagemAvisada(
    orgId: string,
    conversationId: string,
    passagemId: string,
    desde: Date,
  ): Promise<boolean>;
  /** INSERT com a `unique`; `criada:false` = outro processo chegou primeiro. */
  reivindicaEntrega(entrada: {
    organizationId: string;
    passagemId: string;
    destino: string;
    channelSessionId: string | null;
  }): Promise<{ criada: boolean; entrega: EntregaDoAvisoDePassagem | null }>;
  atualizaEntrega(orgId: string, entregaId: string, patch: PatchDaEntregaDePassagem): Promise<void>;
  /** As últimas mensagens da conversa até `ate`, da mais nova para a mais antiga. */
  mensagensAte(
    orgId: string,
    conversationId: string,
    ate: Date,
    limite: number,
  ): Promise<MensagemParaAvaliar[]>;
}

export interface AvisoDePassagemDeps {
  db: AvisoDePassagemDb;
  /** Os adapters do aviso de caso, reaproveitados (ver o cabeçalho). */
  canais: Pick<
    AvisoDb,
    "carregaCanal" | "destinoEhDaPropriaOrganizacao" | "registraJidDoAviso" | "marcaDaOrganizacao"
  >;
  transporte: TransporteDoAviso;
  pacing: PacingDoAviso;
  avaliar(entrada: {
    organizationId: string;
    conversationId: string;
    idioma: Idioma;
    motivoCodigo: MotivoDaPassagem;
    mensagens: readonly MensagemParaAvaliar[];
  }): Promise<ResultadoDaAvaliacao>;
  clock: () => Date;
  /** `env.NEXT_PUBLIC_APP_URL` já LIDO pelo chamador. */
  urlPublica: string;
  origemDoDreno: () => "worker" | "request";
}

export interface DesfechoDoAvisoDePassagem {
  /** NUNCA `error` — ver o cabeçalho. */
  status: "ok" | "skipped" | "retry";
  detail: string;
  retry_at?: string;
}

function skipped(detail: string): DesfechoDoAvisoDePassagem {
  return { status: "skipped", detail };
}
function retry(quando: Date, detail: string): DesfechoDoAvisoDePassagem {
  return { status: "retry", detail, retry_at: quando.toISOString() };
}
function textoOuNulo(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function passouDoTeto(row: EventRow, agora: Date): boolean {
  if (!row.created_at) return false;
  const emitido = Date.parse(row.created_at);
  if (Number.isNaN(emitido)) return false;
  return agora.getTime() - emitido > IDADE_MAXIMA_DO_EVENTO_MS;
}

/**
 * O trecho que disparou e a sondagem, lidos das mensagens.
 *
 * Considera só o que veio ATÉ a passagem. Com sondagem (a mensagem marcada com
 * `metadata.sondagem_de_passagem`, no alcance de 2 h), a mensagem que disparou é
 * a última fala do cliente ANTES dela, e a resposta é a primeira DEPOIS; sem
 * sondagem, é a última fala do cliente antes da passagem.
 */
export function lerGatilhoESondagem(
  mensagens: readonly MensagemParaAvaliar[],
  passagemEm: Date,
): { mensagemQueDisparou: string | null; sondagem: SondagemParaOAviso | null } {
  const limite = passagemEm.getTime() + FOLGA_DO_INSTANTE_DA_PASSAGEM_MS;
  const ordenadas = [...mensagens]
    .filter((m) => Date.parse(m.created_at) <= limite)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const texto = (m: MensagemParaAvaliar): string | null =>
    textoOuNulo(m.body) ?? textoOuNulo(m.media_derived_text ?? null);
  const doCliente = (m: MensagemParaAvaliar) => m.direction === "inbound" && texto(m) !== null;

  const sondagem = [...ordenadas]
    .reverse()
    .find(
      (m) =>
        m.direction === "outbound" &&
        Boolean(m.metadata?.sondagem_de_passagem) &&
        passagemEm.getTime() - Date.parse(m.created_at) <= ALCANCE_DA_SONDAGEM_MS,
    );
  if (!sondagem) {
    const ultima = [...ordenadas].reverse().find(doCliente);
    return { mensagemQueDisparou: ultima ? texto(ultima) : null, sondagem: null };
  }
  const em = Date.parse(sondagem.created_at);
  const antes = ordenadas.filter((m) => Date.parse(m.created_at) < em && doCliente(m)).at(-1);
  const resposta = ordenadas.find((m) => Date.parse(m.created_at) > em && doCliente(m));
  return {
    mensagemQueDisparou: antes ? texto(antes) : null,
    sondagem: resposta
      ? { respondeu: true, resposta: texto(resposta) }
      : { respondeu: false, minutos: Math.max(0, Math.round((passagemEm.getTime() - em) / 60_000)) },
  };
}

/**
 * Aplica UMA linha de `ai.handoff_recorded`. A ordem segue a do aviso de caso:
 * o mais barato primeiro, e o caminho de toda instalação que nunca ligou o
 * aviso termina no passo 2, com uma leitura e zero rede.
 */
export async function aplicaAvisoDePassagem(
  deps: AvisoDePassagemDeps,
  row: EventRow,
): Promise<DesfechoDoAvisoDePassagem> {
  const agora = deps.clock();
  const orgId = row.organization_id;
  if (row.event_type !== EVENTO_PASSAGEM_REGISTRADA) return skipped("evento_ignorado");

  // ── 0. Dreno DENTRO da requisição: adia sem tocar a rede ─────────────────
  if (deps.origemDoDreno() === "request") {
    return retry(
      new Date(agora.getTime() + ADIAMENTO_DO_DRENO_EM_REQUEST_MS),
      "adiado: dreno dentro do webhook",
    );
  }

  // ── 1. O evento descreve o fato? ─────────────────────────────────────────
  const passagemId = textoOuNulo(row.payload.passagem_id) ?? row.entity_id ?? null;
  if (!passagemId) return skipped("payload_incompleto");

  // ── 2. Configuração ──────────────────────────────────────────────────────
  const cfg = await deps.db.carregaConfig(orgId);
  if (!cfg || !cfg.ligado || !cfg.aviso_de_passagem_ligado || !cfg.channel_session_id) {
    return skipped("sem_configuracao");
  }
  const channelSessionId = cfg.channel_session_id;

  // ── 3. Teto de idade do EVENTO ───────────────────────────────────────────
  if (passouDoTeto(row, agora)) return skipped("evento_velho");

  // ── 4. A passagem, filtrada pela organização da linha do event_log ───────
  const passagem = await deps.db.carregaPassagem(orgId, passagemId);
  if (!passagem) return skipped("passagem_inexistente");

  // ── 5. Os pulos (decisão do dono) ────────────────────────────────────────
  if (passagem.motivo_codigo === "caso_escalado") return skipped("caso_escalado");
  if (passagem.caso_id && (await deps.db.casoJaAvisado(orgId, passagem.caso_id))) {
    return skipped("ja_houve_aviso_de_caso");
  }
  const contato = await deps.db.carregaContato(orgId, passagem.contact_id);
  if (!contato) return skipped("contato_inexistente");
  if (contato.is_personal) return skipped("contato_pessoal");
  if (contato.is_anonymized) return skipped("titular_anonimizado");
  const conversa = await deps.db.carregaConversa(orgId, passagem.conversation_id);
  if (!conversa) return skipped("conversa_inexistente");
  if (conversa.is_group) return skipped("grupo");
  if (passagem.reconhecido_em || conversa.assignee_kind === "user") return skipped("humano_assumiu");
  if (
    await deps.db.outraPassagemAvisada(
      orgId,
      passagem.conversation_id,
      passagem.id,
      new Date(agora.getTime() - JANELA_ENTRE_AVISOS_DA_CONVERSA_MS),
    )
  ) {
    return skipped("outra_passagem_avisada_ha_pouco");
  }

  // ── 6. REIVINDICA antes de tocar a rede ──────────────────────────────────
  const { criada, entrega } = await deps.db.reivindicaEntrega({
    organizationId: orgId,
    passagemId: passagem.id,
    destino: cfg.telefone_destino,
    channelSessionId,
  });
  if (!entrega) return skipped("reivindicacao_sem_linha");
  const ja = entrega.partes_enviadas ?? 0;
  if (!criada) {
    if (entrega.status !== "pendente") return skipped(`ja_resolvido:${entrega.status}`);
    if (entrega.tentativas >= TETO_ABSOLUTO_DE_TENTATIVAS) {
      return await falha(deps, orgId, entrega, "indeterminado", "teto absoluto");
    }
    // A janela só protege a PRIMEIRA parte, como no aviso de caso em partes.
    const desdeOToque = agora.getTime() - Date.parse(entrega.updated_at);
    if (ja === 0 && desdeOToque >= 0 && desdeOToque < JANELA_DE_REIVINDICACAO_MS) {
      return retry(
        new Date(agora.getTime() + JANELA_DE_REIVINDICACAO_MS),
        "outra rodada está enviando este aviso",
      );
    }
  }

  // ── 7. Validade da entrega ───────────────────────────────────────────────
  const idadeDaEntrega = agora.getTime() - Date.parse(entrega.created_at);
  if (Number.isFinite(idadeDaEntrega) && idadeDaEntrega > VALIDADE_DA_ENTREGA_MS) {
    return await falha(deps, orgId, entrega, "expirou", null, "cancelado");
  }

  const tentativas = entrega.tentativas + 1;

  // ── 8–12. Prontidão do canal — ESPELHO dos passos 8–12 de aplicaAvisoDeCaso;
  //          conferir ao rebasear ─────────────────────────────────────────────
  const canal = await deps.canais.carregaCanal(orgId, channelSessionId);
  if (!canal || canal.archived_at) return await falha(deps, orgId, entrega, "canal_arquivado", null);
  if (canal.desativado) return await falha(deps, orgId, entrega, "canal_desativado", null);
  if (!canal.aceitaMensagemLivre) {
    return await falha(deps, orgId, entrega, "canal_nao_aceita_aviso_livre", null);
  }
  if (canal.status !== "WORKING") {
    if (tentativas >= TETO_DE_TENTATIVAS_DO_CANAL) {
      return await falha(deps, orgId, entrega, "canal_desconectado", canal.status);
    }
    await deps.db.atualizaEntrega(orgId, entrega.id, { tentativas, erro_codigo: "canal_desconectado" });
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_CANAL_MS), `canal ${canal.status}`);
  }
  if (!urlPublicaUsavel(deps.urlPublica)) {
    return await falha(deps, orgId, entrega, "sem_endereco_publico", null);
  }
  if (!(await deps.transporte.configurado(orgId, canal))) {
    if (tentativas >= TETO_DE_TENTATIVAS_DE_ENVIO) {
      return await falha(deps, orgId, entrega, "transporte_ausente", null);
    }
    await deps.db.atualizaEntrega(orgId, entrega.id, { tentativas, erro_codigo: "transporte_ausente" });
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_CANAL_MS), "transporte fora do ar");
  }
  const pacing = await deps.pacing.decide(orgId, channelSessionId, agora);
  if (!pacing.liberado) {
    await deps.db.atualizaEntrega(orgId, entrega.id, {
      erro_codigo: pacing.motivo === "teto_diario" ? "teto_diario_do_numero" : null,
    });
    return retry(pacing.liberaEm, `pacing:${pacing.motivo}`);
  }
  if (await deps.canais.destinoEhDaPropriaOrganizacao(orgId, cfg.telefone_destino)) {
    return await falha(deps, orgId, entrega, "destino_da_propria_organizacao", null);
  }
  const to = await deps.transporte.resolveDestino(orgId, canal, cfg.telefone_destino);
  if (!to) return await falha(deps, orgId, entrega, "destino_invalido", null);

  // ── 13. O texto — a avaliação só na PRIMEIRA parte ───────────────────────
  //
  // A segunda parte é só o link: ela não depende da avaliação nem das
  // mensagens, então a reentrada não paga de novo nem o modelo nem a leitura.
  const marca = await deps.canais.marcaDaOrganizacao(orgId);
  const link = linkDaConversa(deps.urlPublica, passagem.conversation_id);
  let hipotese: HipoteseDaPassagem | null = null;
  let partes: string[];
  if (ja === 0) {
    const passagemEm = new Date(passagem.criado_em);
    const mensagens = await deps.db.mensagensAte(
      orgId,
      passagem.conversation_id,
      new Date(passagemEm.getTime() + FOLGA_DO_INSTANTE_DA_PASSAGEM_MS),
      MENSAGENS_LIDAS,
    );
    const { mensagemQueDisparou, sondagem } = lerGatilhoESondagem(mensagens, passagemEm);
    const avaliacao = await deps.avaliar({
      organizationId: orgId,
      conversationId: passagem.conversation_id,
      idioma: marca.idioma,
      motivoCodigo: passagem.motivo_codigo,
      mensagens,
    });
    hipotese = avaliacao.disponivel ? avaliacao.hipotese : null;
    partes = montarPartesDoAvisoDePassagem({
      marca: marca.nome,
      idioma: marca.idioma,
      motivoCodigo: passagem.motivo_codigo,
      nomeDoCliente: contato.nome,
      mensagemQueDisparou,
      sondagem,
      avaliacao: avaliacao.disponivel ? avaliacao : null,
      link,
    });
  } else {
    partes = montarPartesDoAvisoDePassagem({
      marca: marca.nome,
      idioma: marca.idioma,
      motivoCodigo: passagem.motivo_codigo,
      nomeDoCliente: null,
      mensagemQueDisparou: null,
      sondagem: null,
      avaliacao: null,
      link,
    });
  }
  const n = partes.length;
  if (ja >= n) {
    await deps.db.atualizaEntrega(orgId, entrega.id, { status: "enviado", enviado_em: agora.toISOString() });
    return { status: "ok", detail: `enviado partes=${ja}` };
  }

  // ── 14. O transporte — a parte `ja` e só ela ─────────────────────────────
  let externalId: string | null = null;
  try {
    externalId = (
      await enviarParte({
        transporte: deps.transporte,
        pacing: deps.pacing,
        organizationId: orgId,
        canal,
        channelSessionId,
        to,
        partes,
        jaEnviadas: ja,
        agora,
      })
    ).externalId;
  } catch (err) {
    const causa = err instanceof Error ? err.message : String(err);
    if (tentativas >= TETO_DE_TENTATIVAS_DE_ENVIO) {
      if (ja === 0) return await falha(deps, orgId, entrega, "falha_no_envio", causa);
      // O conteúdo já chegou; só o link ficou para trás. Não é "não saiu".
      logger.warn("[aviso-de-passagem] aviso incompleto", {
        organizationId: orgId,
        entregaId: entrega.id,
        partes: `${ja}/${n}`,
        causa: causa.slice(0, 300),
      });
      await deps.db.atualizaEntrega(orgId, entrega.id, {
        status: "enviado",
        tentativas,
        erro_codigo: "falha_no_envio",
        enviado_em: agora.toISOString(),
      });
      return { status: "ok", detail: `enviado incompleto ${ja}/${n}` };
    }
    await deps.db.atualizaEntrega(orgId, entrega.id, { tentativas, erro_codigo: "falha_no_envio" });
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_CANAL_MS), "envio recusado");
  }

  // ── 14b. Parte que NÃO é a última ────────────────────────────────────────
  if (ja + 1 < n) {
    await deps.db.atualizaEntrega(orgId, entrega.id, {
      partes_enviadas: ja + 1,
      tentativas: 0,
      erro_codigo: null,
      ...(ja === 0
        ? {
            external_id: externalId,
            hipotese,
            // O TEXTO NUNCA É GUARDADO: o hash do aviso inteiro, gravado quando
            // ele foi montado com a avaliação — a reentrada não o remonta.
            corpo_hash: createHash("sha256").update(partes.join("\n")).digest("hex"),
          }
        : {}),
    });
    if (ja === 0) {
      try {
        await deps.canais.registraJidDoAviso(orgId, to);
      } catch (err) {
        logger.warn("[aviso-de-passagem] JID do destino não registrado", {
          organizationId: orgId,
          causa: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return retry(await proximoInstante(deps.pacing, orgId, channelSessionId, agora), `parte ${ja + 1}/${n}`);
  }

  // ── 15. Saiu ─────────────────────────────────────────────────────────────
  await deps.db.atualizaEntrega(orgId, entrega.id, {
    status: "enviado",
    tentativas,
    partes_enviadas: n,
    erro_codigo: null,
    enviado_em: agora.toISOString(),
  });
  return { status: "ok", detail: `enviado canal=${channelSessionId} partes=${n}` };
}

/**
 * A falha DEFINITIVA: grava o desfecho e loga. Sem Central (ver o cabeçalho),
 * e `skipped`, nunca `error`: o fato está gravado na linha da entrega.
 */
async function falha(
  deps: AvisoDePassagemDeps,
  orgId: string,
  entrega: EntregaDoAvisoDePassagem,
  codigo: ErroDaEntregaDeAviso,
  detalhe: string | null,
  status: "falhou" | "cancelado" = "falhou",
): Promise<DesfechoDoAvisoDePassagem> {
  await deps.db.atualizaEntrega(orgId, entrega.id, {
    status,
    tentativas: entrega.tentativas + 1,
    erro_codigo: codigo,
  });
  logger.warn("[aviso-de-passagem] aviso não saiu", {
    organizationId: orgId,
    entregaId: entrega.id,
    erro_codigo: codigo,
    destino_mascarado: mascara(entrega.destino),
    ...(detalhe ? { detalhe: detalhe.slice(0, 300) } : {}),
  });
  return skipped(`${status}:${codigo}`);
}

// ---------------------------------------------------------------------------
// Adapter de produção — `AvisoDePassagemDb` sobre o client de service role.
// ---------------------------------------------------------------------------

const COLUNAS_DA_ENTREGA =
  "id, organization_id, passagem_id, destino, status, tentativas, partes_enviadas, created_at, updated_at";

/**
 * ⚠️ TODA consulta filtra `organization_id` À MÃO: o client é o de service
 * role, que BYPASSA a RLS. A organização vem da linha do `event_log`.
 */
export function createSupabaseAvisoDePassagemDb(admin: SupabaseClient): AvisoDePassagemDb {
  return {
    async carregaConfig(orgId) {
      const { data, error } = await admin
        .from("config_aviso_de_caso")
        .select(
          "organization_id, channel_session_id, telefone_destino, ligado, aviso_de_passagem_ligado, sondagem_minutos",
        )
        .eq("organization_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as ConfigDoAvisoDePassagem | null) ?? null;
    },

    async carregaPassagem(orgId, passagemId) {
      const { data, error } = await admin
        .from("passagens_de_atendimento")
        .select("id, organization_id, conversation_id, contact_id, caso_id, motivo_codigo, criado_em, reconhecido_em")
        .eq("organization_id", orgId)
        .eq("id", passagemId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as PassagemDoAviso | null) ?? null;
    },

    async carregaConversa(orgId, conversationId) {
      const { data, error } = await admin
        .from("conversations")
        .select("is_group, assignee_kind")
        .eq("organization_id", orgId)
        .eq("id", conversationId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const c = data as { is_group: boolean | null; assignee_kind: string | null };
      return { is_group: Boolean(c.is_group), assignee_kind: c.assignee_kind };
    },

    async carregaContato(orgId, contactId) {
      const { data, error } = await admin
        .from("contacts")
        .select("name, display_name, is_personal, is_anonymized")
        .eq("organization_id", orgId)
        .eq("id", contactId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const c = data as {
        name: string | null;
        display_name: string | null;
        is_personal: boolean | null;
        is_anonymized: boolean | null;
      };
      const { nomeDoContato } = await import("@/lib/contacts/rotulo-do-contato");
      return {
        nome: nomeDoContato(c as never),
        is_personal: Boolean(c.is_personal),
        is_anonymized: Boolean(c.is_anonymized),
      };
    },

    async casoJaAvisado(orgId, casoId) {
      const { data, error } = await admin
        .from("entregas_de_aviso_de_caso")
        .select("id")
        .eq("organization_id", orgId)
        .eq("case_id", casoId)
        .in("status", ["pendente", "enviado"])
        .limit(1);
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    },

    async outraPassagemAvisada(orgId, conversationId, passagemId, desde) {
      // Duas leituras, e não um embed: `entregas_de_aviso_de_passagem` não tem
      // a conversa (o ponteiro é a passagem), e a janela é curta — poucas linhas.
      const { data: passagens, error } = await admin
        .from("passagens_de_atendimento")
        .select("id")
        .eq("organization_id", orgId)
        .eq("conversation_id", conversationId)
        .neq("id", passagemId)
        .gte("criado_em", new Date(desde.getTime() - VALIDADE_DA_ENTREGA_MS).toISOString());
      if (error) throw new Error(error.message);
      const ids = ((passagens ?? []) as Array<{ id: string }>).map((p) => p.id);
      if (ids.length === 0) return false;
      const { data: entregas, error: erroDasEntregas } = await admin
        .from("entregas_de_aviso_de_passagem")
        .select("id")
        .eq("organization_id", orgId)
        .in("passagem_id", ids)
        .in("status", ["pendente", "enviado"])
        .gte("created_at", desde.toISOString())
        .limit(1);
      if (erroDasEntregas) throw new Error(erroDasEntregas.message);
      return (entregas ?? []).length > 0;
    },

    async reivindicaEntrega({ organizationId, passagemId, destino, channelSessionId }) {
      const { data, error } = await admin
        .from("entregas_de_aviso_de_passagem")
        .insert({
          organization_id: organizationId,
          passagem_id: passagemId,
          destino,
          channel_session_id: channelSessionId,
          status: "pendente",
        })
        .select(COLUNAS_DA_ENTREGA)
        .maybeSingle();
      if (!error) return { criada: true, entrega: (data as EntregaDoAvisoDePassagem | null) ?? null };
      // 23505 = a `unique (organization_id, passagem_id, destino)` — o caminho
      // NORMAL sob concorrência.
      if (error.code !== "23505") throw new Error(error.message);
      const relida = await admin
        .from("entregas_de_aviso_de_passagem")
        .select(COLUNAS_DA_ENTREGA)
        .eq("organization_id", organizationId)
        .eq("passagem_id", passagemId)
        .eq("destino", destino)
        .maybeSingle();
      if (relida.error) throw new Error(relida.error.message);
      return { criada: false, entrega: (relida.data as EntregaDoAvisoDePassagem | null) ?? null };
    },

    async atualizaEntrega(orgId, entregaId, patch) {
      const { error } = await admin
        .from("entregas_de_aviso_de_passagem")
        .update(patch)
        .eq("organization_id", orgId)
        .eq("id", entregaId);
      if (error) throw new Error(error.message);
    },

    async mensagensAte(orgId, conversationId, ate, limite) {
      const { data, error } = await admin
        .from("messages")
        .select("direction, sent_via, body, media_derived_text, metadata, created_at")
        .eq("organization_id", orgId)
        .eq("conversation_id", conversationId)
        .lte("created_at", ate.toISOString())
        .order("created_at", { ascending: false })
        .limit(limite);
      if (error) throw new Error(error.message);
      return (data ?? []) as MensagemParaAvaliar[];
    },
  };
}
