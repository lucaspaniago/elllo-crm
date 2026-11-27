import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  corpoComDisparo,
  decidirSilencio,
  desembrulharMensagem,
  detectarDisparoAutomatico,
  metadataDoDisparo,
  type DisparoAutomatico,
  type PayloadDoDisparo,
} from "@/lib/waha/disparo-automatico";

/**
 * Fork elllo — o caso real de 07/11/2026, anonimizado: um modelo de marketing
 * do WhatsApp Business com imagem de cabeçalho, texto, rodapé e dois botões. O
 * WAHA (NOWEB) entregou `body: null` e `hasMedia: true`, e o CRM gravou uma
 * imagem sem texto.
 */
const REAL = JSON.parse(
  readFileSync("lib/waha/__fixtures__/disparo-template-noweb-2026.7.2.json", "utf8"),
) as PayloadDoDisparo & { _data: { message: Record<string, unknown> } };

const TEXTO_DO_REAL =
  "*ESQUENTA BLACK FRIDAY – RÁDIO ACADEMIA*\n\nVocê foi selecionado para receber um dos *10 cupons exclusivos de 50% de desconto*..." +
  "\n\nResponda SIM, CUPOM abaixo!" +
  "\n\n[SIM, CUPOM] [ARQUIVAR]";

function noweb(message: unknown, extra: Record<string, unknown> = {}): PayloadDoDisparo {
  return { body: null, _data: { message, ...extra } };
}

describe("o caso real (modelo NOWEB com imagem)", () => {
  it("é disparo automático do tipo template, com o texto legível e a empresa verificada", () => {
    expect(detectarDisparoAutomatico(REAL)).toEqual({
      automatico: true,
      tipo: "template",
      texto: TEXTO_DO_REAL,
      empresa: "Rádio Exemplo Indoor",
    });
  });

  it("o corpo vazio do WAHA vira o texto do modelo, e o metadata marca o disparo sem repetir o texto", () => {
    const d = detectarDisparoAutomatico(REAL);
    const corpo = corpoComDisparo(null, d);
    expect(corpo).toBe(TEXTO_DO_REAL);
    expect(metadataDoDisparo(d, corpo)).toEqual({
      disparo_automatico: { tipo: "template", empresa: "Rádio Exemplo Indoor" },
    });
  });
});

describe("mensagem de gente não é disparo", () => {
  it("texto comum (conversation / extendedTextMessage)", () => {
    expect(detectarDisparoAutomatico(noweb({ conversation: "oi, tudo bem?" }))).toBeNull();
    expect(detectarDisparoAutomatico(noweb({ extendedTextMessage: { text: "quanto custa?" } }))).toBeNull();
    expect(detectarDisparoAutomatico({ body: "oi" })).toBeNull();
    expect(detectarDisparoAutomatico(null)).toBeNull();
  });

  it("imagem comum com legenda", () => {
    expect(detectarDisparoAutomatico(noweb({ imageMessage: { caption: "olha a foto" } }))).toBeNull();
  });

  it("a PESSOA tocando num botão (as respostas) — é o cliente respondendo, nunca silenciar", () => {
    const respostas = [
      { buttonsResponseMessage: { selectedButtonId: "1", selectedDisplayText: "SIM, CUPOM" } },
      { templateButtonReplyMessage: { selectedId: "1", selectedDisplayText: "Quero" } },
      { listResponseMessage: { title: "Opção 1", singleSelectReply: { selectedRowId: "a" } } },
      { interactiveResponseMessage: { body: { text: "Enviar" } } },
    ];
    for (const r of respostas) expect(detectarDisparoAutomatico(noweb(r))).toBeNull();
    // embrulhada também não
    expect(detectarDisparoAutomatico(noweb({ ephemeralMessage: { message: respostas[0] } }))).toBeNull();
  });

  it("com `message` NOWEB presente, o `type` não decide", () => {
    expect(detectarDisparoAutomatico({ type: "list", _data: { message: { conversation: "oi" } } })).toBeNull();
  });
});

describe("envoltórios", () => {
  it("mensagem temporária, visualização única e edição embrulham o modelo", () => {
    const modelo = REAL._data.message;
    for (const envoltorio of ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "editedMessage"]) {
      const d = detectarDisparoAutomatico(noweb({ [envoltorio]: { message: modelo } }, { verifiedBizName: "X" }));
      expect(d?.tipo, envoltorio).toBe("template");
      expect(d?.texto).toBe(TEXTO_DO_REAL);
    }
  });

  it("dois níveis (temporária dentro de visualização única)", () => {
    const d = detectarDisparoAutomatico(
      noweb({ viewOnceMessageV2: { message: { ephemeralMessage: { message: REAL._data.message } } } }),
    );
    expect(d?.tipo).toBe("template");
    expect(d?.empresa).toBeNull();
  });

  it("estrutura cíclica não trava o desembrulho", () => {
    const a: Record<string, unknown> = {};
    a.ephemeralMessage = { message: a };
    expect(() => desembrulharMensagem(a)).not.toThrow();
    expect(detectarDisparoAutomatico(noweb(a))).toBeNull();
  });
});

describe("as outras formas de disparo", () => {
  it("buttonsMessage", () => {
    const d = detectarDisparoAutomatico(
      noweb({
        buttonsMessage: {
          contentText: "Seu pedido saiu para entrega",
          footerText: "Loja Exemplo",
          buttons: [{ buttonId: "1", buttonText: { displayText: "Rastrear" }, type: 1 }],
        },
      }),
    );
    expect(d).toEqual({
      automatico: true,
      tipo: "botoes",
      texto: "Seu pedido saiu para entrega\n\nLoja Exemplo\n\n[Rastrear]",
      empresa: null,
    });
  });

  it("listMessage: as opções viram a linha de botões", () => {
    const d = detectarDisparoAutomatico(
      noweb({
        listMessage: {
          title: "Cardápio",
          description: "Escolha o prato do dia",
          buttonText: "Ver opções",
          sections: [{ title: "Pratos", rows: [{ title: "Feijoada", rowId: "1" }, { title: "Lasanha", rowId: "2" }] }],
        },
      }),
    );
    expect(d?.tipo).toBe("lista");
    expect(d?.texto).toBe("Cardápio\n\nEscolha o prato do dia\n\n[Feijoada] [Lasanha]");
  });

  it("interactiveMessage com nativeFlow (rótulo em buttonParamsJson)", () => {
    const d = detectarDisparoAutomatico(
      noweb({
        interactiveMessage: {
          header: { title: "Oferta" },
          body: { text: "Só hoje: frete grátis" },
          footer: { text: "Responda SAIR para não receber" },
          nativeFlowMessage: {
            buttons: [
              { name: "cta_url", buttonParamsJson: JSON.stringify({ display_text: "Comprar", url: "https://x" }) },
              { name: "quick_reply", buttonParamsJson: "{json torto" },
            ],
          },
        },
      }),
    );
    expect(d?.tipo).toBe("interativa");
    expect(d?.texto).toBe("Oferta\n\nSó hoje: frete grátis\n\nResponda SAIR para não receber\n\n[Comprar]");
  });

  it("modelo sem hydratedTemplate legível ainda é disparo, com texto null", () => {
    const d = detectarDisparoAutomatico(noweb({ templateMessage: { fourRowTemplate: { content: {} } } }));
    expect(d).toEqual({ automatico: true, tipo: "template", texto: null, empresa: null });
  });

  it("WEBJS (tolerado): `type` do WhatsApp Web e `isFromTemplate`", () => {
    expect(detectarDisparoAutomatico({ type: "hsm", body: "Promoção", _data: { footer: "Loja" } })).toEqual({
      automatico: true,
      tipo: "template",
      texto: "Promoção\n\nLoja",
      empresa: null,
    });
    expect(detectarDisparoAutomatico({ body: "Oi", _data: { isFromTemplate: true } })?.tipo).toBe("template");
    expect(detectarDisparoAutomatico({ type: "buttons_response", body: "Sim", _data: {} })).toBeNull();
    expect(detectarDisparoAutomatico({ type: "chat", body: "oi", _data: {} })).toBeNull();
  });
});

describe("corpo e metadata", () => {
  const d: DisparoAutomatico = { automatico: true, tipo: "template", texto: "Modelo\n\n[OK]", empresa: null };

  it("corpo do WAHA presente vence; o texto inteiro vai para o metadata", () => {
    expect(corpoComDisparo("Modelo", d)).toBe("Modelo");
    expect(metadataDoDisparo(d, "Modelo")).toEqual({
      disparo_automatico: { tipo: "template", empresa: null, texto: "Modelo\n\n[OK]" },
    });
  });

  it("mensagem comum: corpo intacto e metadata vazio", () => {
    expect(corpoComDisparo("oi", null)).toBe("oi");
    expect(corpoComDisparo(null, null)).toBeNull();
    expect(metadataDoDisparo(null, "oi")).toEqual({});
  });
});

describe("decidirSilencio", () => {
  const disparo = detectarDisparoAutomatico(REAL);
  const base = { disparo, ligado: true, jaEscrevemos: false, contatoPessoal: false };

  it("ligado + nunca escrevemos = silencia", () => {
    expect(decidirSilencio(base)).toEqual({ silenciar: true, motivo: "silenciar" });
  });

  it("desligado = como hoje", () => {
    expect(decidirSilencio({ ...base, ligado: false })).toEqual({ silenciar: false, motivo: "desligado" });
  });

  it("nós escrevemos primeiro = prospect respondendo por robô, segue atendido", () => {
    expect(decidirSilencio({ ...base, jaEscrevemos: true })).toEqual({ silenciar: false, motivo: "ja_escrevemos" });
  });

  it("contato pessoal não é etiquetado de propaganda", () => {
    expect(decidirSilencio({ ...base, contatoPessoal: true })).toEqual({ silenciar: false, motivo: "contato_pessoal" });
  });

  it("mensagem de gente nunca é silenciada", () => {
    expect(decidirSilencio({ ...base, disparo: null })).toEqual({ silenciar: false, motivo: "nao_automatico" });
  });
});
