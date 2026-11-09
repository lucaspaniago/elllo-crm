/**
 * O TEXTO DO AVISO DE PASSAGEM AO DONO (fork elllo) — o que ele diz e o que nunca diz.
 *
 * Duas partes: o conteúdo e o link da conversa. O desvio consciente em relação
 * ao aviso de caso — o TRECHO da mensagem do cliente vai no aviso — é estreito:
 * até 160 caracteres, sem link, sem CPF, sem telefone, entre aspas. Os casos de
 * ausência valem tanto quanto os de presença.
 */
import { describe, expect, it } from "vitest";

import {
  TETO_DO_TRECHO_DO_CLIENTE,
  linkDaConversa,
  montarNotaDeTomAspero,
  montarPartesDoAvisoDePassagem,
  type AvisoDePassagem,
} from "@/lib/escalacao/texto-do-aviso-de-passagem";

const CONVERSA = "0b1f7a2e-0000-4000-8000-000000000000";

const BASE: AvisoDePassagem = {
  marca: "Acme",
  idioma: "pt-BR",
  motivoCodigo: "low_sentiment",
  nomeDoCliente: "Maria Aparecida de Souza",
  mensagemQueDisparou: "isso é um absurdo, ninguém resolve nada",
  avaliacao: {
    hipotese: "brincadeira",
    confianca: 0.78,
    indicios: ["tom de piada", "riu na mensagem seguinte"],
    recomendacao: "confirmar o boleto e seguir",
    contexto: "pediu a segunda via do boleto",
  },
  link: linkDaConversa("https://crm.exemplo.com.br/", CONVERSA),
};

describe("montarPartesDoAvisoDePassagem", () => {
  it("duas partes: o conteúdo inteiro e o link da conversa na Inbox", () => {
    const partes = montarPartesDoAvisoDePassagem(BASE);
    expect(partes).toHaveLength(2);
    expect(partes[0]).toBe(
      [
        "🔔 Acme: atendimento passou para você",
        "",
        "Motivo: O cliente demonstrou irritação na conversa",
        "Cliente: Maria",
        'Mensagem que disparou: "isso é um absurdo, ninguém resolve nada"',
        "Contexto: pediu a segunda via do boleto",
        "Avaliação da IA: provável brincadeira (78%)",
        "Indícios: tom de piada; riu na mensagem seguinte",
        "Recomendação: confirmar o boleto e seguir",
      ].join("\n"),
    );
    expect(partes[1]).toBe(`Abrir: https://crm.exemplo.com.br/app/inbox?id=${CONVERSA}`);
  });

  it("não há linha de sondagem: a IA não faz mais pergunta separada", () => {
    const [conteudo] = montarPartesDoAvisoDePassagem({ ...BASE, motivoCodigo: "requested_human" });
    expect(conteudo).not.toContain("Sondagem");
    expect(conteudo).toContain("Motivo: O cliente pediu para falar com uma pessoa");
  });

  it("avaliação indisponível: diz que não há, sem contexto inventado", () => {
    const [conteudo] = montarPartesDoAvisoDePassagem({ ...BASE, avaliacao: null });
    expect(conteudo).toContain("Avaliação indisponível");
    expect(conteudo).not.toContain("Contexto:");
    expect(conteudo).not.toContain("Indícios:");
    expect(conteudo).not.toContain("provável");
  });

  it("o trecho do cliente é limpo, curto e citado: sem link, CPF, telefone nem marcador", () => {
    const [conteudo] = montarPartesDoAvisoDePassagem({
      ...BASE,
      mensagemQueDisparou:
        "*meu cpf* 529.982.247-25, liga no +55 31 99896-6398 ou veja https://mal.example/x " +
        "a".repeat(300),
    });
    expect(conteudo).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
    expect(conteudo).not.toContain("998966398");
    expect(conteudo).not.toContain("mal.example");
    expect(conteudo).not.toContain("*");
    const linha = conteudo!.split("\n").find((l) => l.startsWith("Mensagem que disparou"))!;
    const citado = linha.slice(linha.indexOf('"') + 1, linha.lastIndexOf('"'));
    expect([...citado].length).toBeLessThanOrEqual(TETO_DO_TRECHO_DO_CLIENTE);
    expect(citado.endsWith("…")).toBe(true);
  });

  it("a aspa do cliente não fecha a nossa citação", () => {
    const [conteudo] = montarPartesDoAvisoDePassagem({ ...BASE, mensagemQueDisparou: 'olha "isso" www.mal.example' });
    expect(conteudo).toContain(`Mensagem que disparou: "olha 'isso'"`);
  });

  it("o que o modelo escreveu também é limpo", () => {
    const [conteudo] = montarPartesDoAvisoDePassagem({
      ...BASE,
      avaliacao: {
        ...BASE.avaliacao!,
        recomendacao: "ligar no 31998966398 e mandar https://pague.example",
        indicios: ["cpf 529.982.247-25"],
      },
    });
    expect(conteudo).not.toContain("998966398");
    expect(conteudo).not.toContain("pague.example");
    expect(conteudo).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
  });

  it("linha sem conteúdo não aparece", () => {
    const [conteudo] = montarPartesDoAvisoDePassagem({
      ...BASE,
      nomeDoCliente: null,
      mensagemQueDisparou: "https://so-link.example",
    });
    expect(conteudo).not.toContain("Cliente:");
    expect(conteudo).not.toContain("Mensagem que disparou");
  });

  it("anonimizado: o rótulo sai inteiro", () => {
    const [conteudo] = montarPartesDoAvisoDePassagem({
      ...BASE,
      nomeDoCliente: "Cliente Anonimizado #0b1f7a2e",
    });
    expect(conteudo).toContain("Cliente: Cliente Anonimizado #0b1f7a2e");
  });

  it("espanhol: as frases fixas são traduzidas", () => {
    const partes = montarPartesDoAvisoDePassagem({
      ...BASE,
      idioma: "es",
    });
    expect(partes[0]).toContain("la atención pasó a ti");
    expect(partes[0]).toContain("Mensaje que lo activó");
    expect(partes[0]).toContain("Evaluación de la IA: probable broma (78%)");
    expect(partes[0]).not.toContain("Avaliação");
    expect(partes[1]).toContain("Abrir: ");
  });

  it("a marca vem de fora", () => {
    expect(montarPartesDoAvisoDePassagem({ ...BASE, marca: "Zap do João" })[0]).toContain(
      "🔔 Zap do João:",
    );
  });
});

describe("montarNotaDeTomAspero", () => {
  const NOTA = {
    marca: "Acme",
    idioma: "pt-BR" as const,
    nomeDoCliente: "Ana Paula Paniago",
    mensagem: "Oi, idiota",
    avaliacao: { hipotese: "brincadeira" as const, confianca: 0.85 },
    link: linkDaConversa("https://crm.exemplo.com.br", CONVERSA),
  };

  it("uma mensagem só, curta, com o link no fim", () => {
    expect(montarNotaDeTomAspero(NOTA)).toBe(
      [
        "🔔 Acme: tom áspero, segui atendendo",
        "Cliente: Ana",
        'Mensagem: "Oi, idiota"',
        "Avaliação da IA: provável brincadeira (85%)",
        `Abrir: https://crm.exemplo.com.br/app/inbox?id=${CONVERSA}`,
      ].join("\n"),
    );
  });

  it("o trecho é limpo e curto; linha sem conteúdo não aparece", () => {
    const nota = montarNotaDeTomAspero({
      ...NOTA,
      nomeDoCliente: null,
      mensagem: "liga 31998966398 https://mal.example " + "a".repeat(300),
    });
    expect(nota).not.toContain("998966398");
    expect(nota).not.toContain("mal.example");
    expect(nota).not.toContain("Cliente:");
    const linha = nota.split("\n").find((l) => l.startsWith("Mensagem:"))!;
    expect([...linha.slice(linha.indexOf('"') + 1, linha.lastIndexOf('"'))].length).toBeLessThanOrEqual(
      TETO_DO_TRECHO_DO_CLIENTE,
    );
    expect(montarNotaDeTomAspero({ ...NOTA, mensagem: null })).not.toContain("Mensagem:");
  });

  it("espanhol", () => {
    const nota = montarNotaDeTomAspero({ ...NOTA, idioma: "es", avaliacao: { hipotese: "engano", confianca: 0.7 } });
    expect(nota).toContain("tono áspero, seguí atendiendo");
    expect(nota).toContain("Mensaje:");
    expect(nota).toContain("Evaluación de la IA: probable equivocación (70%)");
  });
});
