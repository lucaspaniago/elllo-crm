/**
 * O TEXTO DO AVISO DE PASSAGEM AO DONO — puro, sem `env`, sem client, sem DOM
 * (fork elllo).
 *
 * ## O que ele é
 *
 * A mensagem que chega no WhatsApp do dono quando o atendimento automático
 * passa uma conversa para uma pessoa, em DUAS partes:
 *
 *     🔔 Acme: atendimento passou para você
 *
 *     Motivo: O cliente demonstrou irritação na conversa
 *     Cliente: Maria
 *     Mensagem que disparou: "isso é um absurdo, ninguém resolve nada"
 *     Contexto: pediu a segunda via do boleto duas vezes sem resposta
 *     Sondagem: enviada · respondeu "não, tá tudo bem, era brincadeira"
 *     Avaliação da IA: provável brincadeira (78%)
 *     Indícios: tom de piada; respondeu logo à sondagem
 *     Recomendação: confirmar o boleto e seguir
 *
 *     ── segunda mensagem ──
 *     Abrir: https://crm.exemplo.com.br/app/inbox?id=<conversa>
 *
 * O link sozinho no segundo balão abre a prévia certa no celular, como no
 * aviso de caso em partes (`montarPartesDoAvisoDeCaso`).
 *
 * ## As decisões, cada uma com o motivo
 *
 * **A marca vem de FORA** (`marcaDaSaida`), e **o idioma é o da ORGANIZAÇÃO**:
 * as mesmas duas regras do aviso de caso (`./texto-do-aviso.ts`), pelos mesmos
 * motivos. Toda frase fixa passa por `traduzir`.
 *
 * **PRIMEIRO nome, só** — `primeiroNome`, a mesma régua do aviso de caso.
 *
 * ⚠️ **DESVIO CONSCIENTE da regra do aviso de caso: o TRECHO da mensagem do
 * cliente VAI no aviso.** O aviso de caso nunca leva trecho de mensagem (é a
 * decisão "detalhes sem dado sensível"). Aqui o dono decidiu o contrário, em
 * 25/10/2026: sem o trecho que disparou, a passagem por sentimento é
 * ilegível — "o cliente demonstrou irritação" não diz se foi um palavrão ou uma
 * piada, e é essa a pergunta que o dono precisa responder do celular. O
 * desvio é ESTREITO: até 160 caracteres, passado por `sanitizarTextoDoLead`
 * (sem link, sem CPF, sem telefone, sem marcador de formatação), e citado entre
 * aspas — é a fala do cliente, nunca uma afirmação do sistema. O mesmo vale
 * para a resposta à sondagem.
 *
 * **O que o modelo escreveu também passa pela limpeza.** Indícios, recomendação
 * e contexto vêm da avaliação (`./avaliacao-da-passagem.ts`), que já os limpa;
 * limpar de novo aqui é o que mantém esta função total e segura sozinha.
 *
 * **Linha sem conteúdo não aparece** — a mesma regra do aviso de caso.
 */
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

import { FRASE_DO_MOTIVO, type MotivoDaPassagem } from "./passagem";
import { sanitizarTextoDoLead } from "./sanitizar-texto-do-lead";
import { primeiroNome } from "./texto-do-aviso";
import { FRASE_DA_HIPOTESE, type HipoteseDaPassagem } from "./vocabulario-do-aviso-de-passagem";

/** Teto do trecho do cliente (a mensagem que disparou e a resposta à sondagem). */
export const TETO_DO_TRECHO_DO_CLIENTE = 160;

/** Tetos do que a avaliação escreveu — os mesmos do contrato Zod dela. */
export const TETOS_DA_AVALIACAO = {
  indicio: 140,
  recomendacao: 200,
  contexto: 240,
} as const;

/** O que a avaliação devolveu, já validado. */
export interface AvaliacaoParaOAviso {
  hipotese: HipoteseDaPassagem;
  /** 0..1 */
  confianca: number;
  indicios: readonly string[];
  recomendacao: string | null;
  contexto: string | null;
}

/** A sondagem que precedeu a passagem, quando houve. */
export type SondagemParaOAviso =
  | { respondeu: true; resposta: string | null }
  | { respondeu: false; minutos: number };

export interface AvisoDePassagem {
  /** O nome da marca já resolvido por `marcaDaSaida(orgId)`. */
  marca: string;
  /** O idioma da ORGANIZAÇÃO, já normalizado. */
  idioma: Idioma;
  motivoCodigo: MotivoDaPassagem;
  /** `contacts.name` inteiro — o corte para o primeiro nome é feito aqui. */
  nomeDoCliente: string | null;
  /** A última fala do cliente antes da sondagem (ou da passagem), CRUA. */
  mensagemQueDisparou: string | null;
  sondagem: SondagemParaOAviso | null;
  /** `null` = avaliação indisponível (orçamento, erro, sem modelo). */
  avaliacao: AvaliacaoParaOAviso | null;
  /** O link já montado pelo servidor (`linkDaConversa`). É o ÚNICO link do texto. */
  link: string;
}

/**
 * O endereço da conversa na Inbox — o MESMO formato que a notificação do
 * navegador usa (`lib/notifications/push.handler.ts`).
 */
export function linkDaConversa(base: string, conversationId: string): string {
  return `${base.replace(/\/+$/, "")}/app/inbox?id=${conversationId}`;
}

function citacao(bruto: string | null | undefined): string | null {
  const limpo = sanitizarTextoDoLead(bruto, TETO_DO_TRECHO_DO_CLIENTE);
  // As aspas do cliente saem: dentro da citação, uma aspa dele fecharia a nossa.
  const semAspas = limpo?.replace(/["“”]/g, "'") ?? null;
  return semAspas ? `"${semAspas}"` : null;
}

/** As duas partes do aviso. Função total: nunca lança, nunca devolve parte vazia. */
export function montarPartesDoAvisoDePassagem(aviso: AvisoDePassagem): string[] {
  const t = (texto: string): string => traduzir(texto, aviso.idioma);
  const linhas: string[] = [`🔔 ${aviso.marca}: ${t("atendimento passou para você")}`, ""];

  linhas.push(`${t("Motivo")}: ${t(FRASE_DO_MOTIVO[aviso.motivoCodigo])}`);

  const cliente = primeiroNome(aviso.nomeDoCliente);
  if (cliente) linhas.push(`${t("Cliente")}: ${cliente}`);

  const disparou = citacao(aviso.mensagemQueDisparou);
  if (disparou) linhas.push(`${t("Mensagem que disparou")}: ${disparou}`);

  const avaliacao = aviso.avaliacao;
  const contexto = sanitizarTextoDoLead(avaliacao?.contexto, TETOS_DA_AVALIACAO.contexto);
  if (contexto) linhas.push(`${t("Contexto")}: ${contexto}`);

  if (aviso.sondagem) {
    const desfecho = aviso.sondagem.respondeu
      ? [t("respondeu"), citacao(aviso.sondagem.resposta)].filter(Boolean).join(" ")
      : `${t("sem resposta em")} ${Math.max(0, Math.round(aviso.sondagem.minutos))} min`;
    linhas.push(`${t("Sondagem")}: ${t("enviada")} · ${desfecho}`);
  }

  if (avaliacao) {
    const pct = Math.round(Math.min(1, Math.max(0, avaliacao.confianca)) * 100);
    linhas.push(
      `${t("Avaliação da IA")}: ${t("provável")} ${t(FRASE_DA_HIPOTESE[avaliacao.hipotese])} (${pct}%)`,
    );
    const indicios = avaliacao.indicios
      .slice(0, 3)
      .map((i) => sanitizarTextoDoLead(i, TETOS_DA_AVALIACAO.indicio))
      .filter((i): i is string => i !== null);
    if (indicios.length > 0) linhas.push(`${t("Indícios")}: ${indicios.join("; ")}`);
    const recomendacao = sanitizarTextoDoLead(
      avaliacao.recomendacao,
      TETOS_DA_AVALIACAO.recomendacao,
    );
    if (recomendacao) linhas.push(`${t("Recomendação")}: ${recomendacao}`);
  } else {
    linhas.push(t("Avaliação indisponível"));
  }

  return [linhas.join("\n"), `${t("Abrir")}: ${aviso.link}`];
}
