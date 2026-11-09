/**
 * DISPARO AUTOMÁTICO DE EMPRESA — a mensagem que nenhuma pessoa digitou.
 *
 * Fork elllo. Caso real (07/11/2026): uma empresa mandou uma mensagem de
 * MODELO do WhatsApp Business (o "template" das campanhas de marketing) para o
 * número do dono. O WAHA (NOWEB) entregou; o CRM gravou uma mensagem `image`
 * com corpo VAZIO — o texto e os botões do modelo se perderam —, abriu
 * contato, conversa e card, e a IA respondeu ("Oi! Aqui é a Helô… Com quem eu
 * falo?") a um robô de propaganda.
 *
 * Este arquivo é PURO: lê o payload cru do WAHA e diz se é disparo automático,
 * de que tipo, de qual empresa, e qual é o texto legível. Quem decide o que
 * fazer com isso é `lib/waha/silencio-de-disparo.ts`.
 *
 * ─── O que conta como disparo automático ───────────────────────────────────
 *
 * As formas que só a API do WhatsApp Business (ou um robô) envia:
 *
 *   templateMessage     modelo aprovado (hydratedTemplate / hydratedFourRowTemplate)
 *   interactiveMessage  mensagem interativa (nativeFlow, carrossel)
 *   buttonsMessage      mensagem com botões
 *   listMessage         mensagem com lista de opções
 *
 * ⚠️ As RESPOSTAS a essas formas NÃO são disparo: `buttonsResponseMessage`,
 * `templateButtonReplyMessage`, `listResponseMessage` e
 * `interactiveResponseMessage` são uma PESSOA tocando num botão — é o cliente
 * respondendo a um disparo NOSSO, e silenciá-lo seria calar quem quer comprar.
 * Elas são chaves diferentes no `message`, então basta não as procurar.
 *
 * ─── Envoltórios ───────────────────────────────────────────────────────────
 *
 * O `message` do NOWEB (Baileys) pode vir embrulhado — mensagem temporária
 * (`ephemeralMessage`), visualização única (`viewOnceMessage*`), documento com
 * legenda, edição. O `lib/waha/ingest.ts` não desembrulha (lê as chaves do
 * primeiro nível); aqui é preciso, porque uma campanha com mensagens
 * temporárias ligadas chega como `ephemeralMessage.message.templateMessage`.
 * O desembrulho segue o `normalizeMessageContent` do Baileys, com teto de
 * profundidade para não seguir estrutura cíclica ou maliciosa.
 *
 * ─── WEBJS ──────────────────────────────────────────────────────────────────
 *
 * O produto usa NOWEB (CLAUDE.md, seção WAHA). A forma do WEBJS (`type` do
 * WhatsApp Web: `hsm`, `template`, `buttons`, `list`, `interactive`,
 * `native_flow`, ou `_data.isFromTemplate`) é TOLERADA por leitura de melhor
 * esforço — não foi medida numa instalação real. O texto, ali, é o `body` que o
 * próprio WEBJS monta, mais título e rodapé quando vierem.
 */

/** O tipo do disparo — vai para `messages.metadata.disparo_automatico.tipo`. */
export type TipoDeDisparo = "template" | "interativa" | "botoes" | "lista";

export interface DisparoAutomatico {
  automatico: true;
  tipo: TipoDeDisparo;
  /** O texto legível do disparo (corpo, rodapé, botões numa linha), ou null. */
  texto: string | null;
  /** `_data.verifiedBizName` — o nome VERIFICADO da empresa, quando vem. */
  empresa: string | null;
}

/** O mínimo do payload do WAHA que a detecção lê (compatível com `WahaPayload`). */
export interface PayloadDoDisparo {
  type?: string | null;
  body?: string | null;
  _data?: { message?: unknown; [k: string]: unknown } | null;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function lista(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Chaves que só EMBRULHAM outra mensagem em `.message` (Baileys,
 * `normalizeMessageContent`). `documentWithCaptionMessage` entra por fidelidade
 * ao Baileys, embora o que ele embrulha nunca seja disparo.
 */
const ENVOLTORIOS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "editedMessage",
  "deviceSentMessage",
  "botInvokeMessage",
  "groupMentionedMessage",
  "associatedChildMessage",
  "groupStatusMessage",
  "groupStatusMessageV2",
] as const;

const PROFUNDIDADE_MAXIMA = 5;

/** O `message` sem envoltórios, ou null quando não é objeto. */
export function desembrulharMensagem(bruto: unknown): Obj | null {
  let atual = obj(bruto);
  for (let nivel = 0; atual && nivel < PROFUNDIDADE_MAXIMA; nivel++) {
    let dentro: Obj | null = null;
    for (const chave of ENVOLTORIOS) {
      dentro = obj(obj(atual[chave])?.message);
      if (dentro) break;
    }
    if (!dentro) return atual;
    atual = dentro;
  }
  return atual;
}

/** A legenda da mídia de cabeçalho (imagem, vídeo, documento), quando há. */
function legendaDoCabecalho(o: Obj | null): string | null {
  if (!o) return null;
  for (const chave of ["imageMessage", "videoMessage", "documentMessage"]) {
    const legenda = str(obj(o[chave])?.caption);
    if (legenda) return legenda;
  }
  return null;
}

/** Botões numa linha só: `[SIM, CUPOM] [ARQUIVAR]` — sem rótulo, sem idioma. */
function linhaDeBotoes(rotulos: Array<string | null>): string | null {
  const limpos = rotulos.filter((r): r is string => r !== null);
  return limpos.length ? limpos.map((r) => `[${r}]`).join(" ") : null;
}

/** Junta os blocos não vazios com linha em branco; nada → null. */
function juntar(blocos: Array<string | null>): string | null {
  const limpos = blocos.filter((b): b is string => b !== null);
  return limpos.length ? limpos.join("\n\n") : null;
}

function textoDoModelo(t: Obj): string | null {
  const h = obj(t.hydratedTemplate) ?? obj(t.hydratedFourRowTemplate);
  if (!h) return null;
  const botoes = lista(h.hydratedButtons).map((b) => {
    const o = obj(b);
    return (
      str(obj(o?.quickReplyButton)?.displayText) ??
      str(obj(o?.urlButton)?.displayText) ??
      str(obj(o?.callButton)?.displayText)
    );
  });
  return juntar([
    str(h.hydratedTitleText),
    legendaDoCabecalho(h),
    str(h.hydratedContentText),
    str(h.hydratedFooterText),
    linhaDeBotoes(botoes),
  ]);
}

function textoDosBotoes(b: Obj): string | null {
  const botoes = lista(b.buttons).map((x) => str(obj(obj(x)?.buttonText)?.displayText));
  return juntar([
    str(b.text),
    legendaDoCabecalho(b),
    str(b.contentText),
    str(b.footerText),
    linhaDeBotoes(botoes),
  ]);
}

function textoDaLista(l: Obj): string | null {
  const opcoes = lista(l.sections).flatMap((s) => lista(obj(s)?.rows).map((r) => str(obj(r)?.title)));
  return juntar([
    str(l.title),
    str(l.description),
    str(l.footerText),
    linhaDeBotoes(opcoes.some((o) => o !== null) ? opcoes : [str(l.buttonText)]),
  ]);
}

/** O rótulo de um botão do nativeFlow: `buttonParamsJson` é JSON em string. */
function rotuloDoFluxo(botao: unknown): string | null {
  const parametros = str(obj(botao)?.buttonParamsJson);
  if (!parametros) return null;
  try {
    return str(obj(JSON.parse(parametros))?.display_text);
  } catch {
    return null;
  }
}

function textoDaInterativa(i: Obj, nivel = 0): string | null {
  const cabecalho = obj(i.header);
  const cartoes =
    nivel === 0
      ? lista(obj(i.carouselMessage)?.cards).map((c) => {
          const cartao = obj(c);
          return cartao ? textoDaInterativa(cartao, nivel + 1) : null;
        })
      : [];
  return juntar([
    str(cabecalho?.title),
    str(cabecalho?.subtitle),
    legendaDoCabecalho(cabecalho),
    str(obj(i.body)?.text),
    ...cartoes,
    str(obj(i.footer)?.text),
    linhaDeBotoes(lista(obj(i.nativeFlowMessage)?.buttons).map(rotuloDoFluxo)),
  ]);
}

/** Tipos do WhatsApp Web (WEBJS) que são disparo; as respostas ficam de fora. */
const TIPOS_WEBJS: Record<string, TipoDeDisparo> = {
  hsm: "template",
  template: "template",
  buttons: "botoes",
  list: "lista",
  interactive: "interativa",
  native_flow: "interativa",
};

function disparoDoWebjs(p: PayloadDoDisparo, dados: Obj): Omit<DisparoAutomatico, "empresa"> | null {
  const bruto = str(p.type) ?? str(dados.type);
  const tipo =
    (bruto ? TIPOS_WEBJS[bruto.toLowerCase()] : undefined) ??
    (dados.isFromTemplate === true || dados.isDynamicReplyButtonsMsg === true ? "template" : undefined);
  if (!tipo) return null;
  const botoes = lista(dados.dynamicReplyButtons).map((b) => str(obj(obj(b)?.buttonText)?.displayText));
  return {
    automatico: true,
    tipo,
    texto: juntar([str(dados.title), str(p.body), str(dados.footer), linhaDeBotoes(botoes)]),
  };
}

/**
 * O disparo automático deste payload, ou `null` quando é mensagem de gente
 * (inclusive a resposta de uma pessoa a um botão).
 */
export function detectarDisparoAutomatico(p: PayloadDoDisparo | null | undefined): DisparoAutomatico | null {
  const dados = obj(p?._data);
  if (!p || !dados) return null;
  const empresa = str(dados.verifiedBizName);
  const msg = desembrulharMensagem(dados.message);

  if (msg) {
    const modelo = obj(msg.templateMessage);
    if (modelo) return { automatico: true, tipo: "template", texto: textoDoModelo(modelo), empresa };
    const interativa = obj(msg.interactiveMessage);
    if (interativa) return { automatico: true, tipo: "interativa", texto: textoDaInterativa(interativa), empresa };
    const botoes = obj(msg.buttonsMessage);
    if (botoes) return { automatico: true, tipo: "botoes", texto: textoDosBotoes(botoes), empresa };
    const opcoes = obj(msg.listMessage);
    if (opcoes) return { automatico: true, tipo: "lista", texto: textoDaLista(opcoes), empresa };
    // Com `message` do NOWEB presente e nenhuma das quatro chaves, a resposta é
    // NÃO — o `type` do WEBJS não se aplica a este payload.
    return null;
  }

  const webjs = disparoDoWebjs(p, dados);
  return webjs ? { ...webjs, empresa } : null;
}

/**
 * O corpo que a mensagem grava: o do WAHA quando há, senão o texto do disparo.
 * Mensagem comum devolve o corpo intacto (inclusive `null`).
 */
export function corpoComDisparo(corpo: string | null, disparo: DisparoAutomatico | null): string | null {
  if (corpo && corpo.trim() !== "") return corpo;
  return disparo?.texto ?? corpo;
}

/**
 * A marca em `messages.metadata`: `{ disparo_automatico: { tipo, empresa } }`.
 *
 * O texto legível só entra quando o corpo gravado NÃO é ele (o WAHA preencheu
 * `body` com o miolo do modelo, sem rodapé nem botões): a tela tem o corpo, e a
 * cópia inteira fica no metadata para quem quiser ler o modelo completo.
 */
export function metadataDoDisparo(
  disparo: DisparoAutomatico | null,
  corpoGravado: string | null,
): Record<string, unknown> {
  if (!disparo) return {};
  return {
    disparo_automatico: {
      tipo: disparo.tipo,
      empresa: disparo.empresa,
      ...(disparo.texto && disparo.texto !== corpoGravado ? { texto: disparo.texto } : {}),
    },
  };
}

// ─── A DECISÃO ──────────────────────────────────────────────────────────────

/**
 * Por que a mensagem foi (ou não) silenciada — vai para o log.
 *
 *   nao_automatico  mensagem de gente: nada muda
 *   desligado       `settings.crm.silenciar_disparos_automaticos === false`
 *   ja_escrevemos   houve envio nosso ao contato antes: é um prospect
 *                   respondendo por robô, e continua sendo atendido
 *   contato_pessoal contato marcado como pessoal: os efeitos já são pulados
 *   silenciar       propaganda de quem nunca recebeu nada nosso
 */
export type MotivoDoSilencio = "nao_automatico" | "desligado" | "ja_escrevemos" | "contato_pessoal" | "silenciar";

export interface FatosDoSilencio {
  disparo: DisparoAutomatico | null;
  /** O botão da organização (padrão ligado). */
  ligado: boolean;
  /** Existe mensagem de saída nossa para este contato, em qualquer conversa. */
  jaEscrevemos: boolean;
  /** `contacts.is_personal`. */
  contatoPessoal: boolean;
}

export function decidirSilencio(f: FatosDoSilencio): { silenciar: boolean; motivo: MotivoDoSilencio } {
  if (!f.disparo) return { silenciar: false, motivo: "nao_automatico" };
  if (!f.ligado) return { silenciar: false, motivo: "desligado" };
  if (f.jaEscrevemos) return { silenciar: false, motivo: "ja_escrevemos" };
  if (f.contatoPessoal) return { silenciar: false, motivo: "contato_pessoal" };
  return { silenciar: true, motivo: "silenciar" };
}
