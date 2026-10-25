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
  sondagem: { respondeu: true, resposta: "não, tá tudo bem, era brincadeira" },
  avaliacao: {
    hipotese: "brincadeira",
    confianca: 0.78,
    indicios: ["tom de piada", "respondeu logo à sondagem"],
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
        'Sondagem: enviada · respondeu "não, tá tudo bem, era brincadeira"',
        "Avaliação da IA: provável brincadeira (78%)",
        "Indícios: tom de piada; respondeu logo à sondagem",
        "Recomendação: confirmar o boleto e seguir",
      ].join("\n"),
    );
    expect(partes[1]).toBe(`Abrir: https://crm.exemplo.com.br/app/inbox?id=${CONVERSA}`);
  });

  it("sondagem sem resposta diz em quantos minutos", () => {
    const [conteudo] = montarPartesDoAvisoDePassagem({
      ...BASE,
      sondagem: { respondeu: false, minutos: 10 },
    });
    expect(conteudo).toContain("Sondagem: enviada · sem resposta em 10 min");
  });

  it("sem sondagem, sem linha de sondagem", () => {
    const [conteudo] = montarPartesDoAvisoDePassagem({ ...BASE, sondagem: null, motivoCodigo: "requested_human" });
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
      sondagem: { respondeu: true, resposta: 'olha "isso" www.mal.example' },
    });
    expect(conteudo).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
    expect(conteudo).not.toContain("998966398");
    expect(conteudo).not.toContain("mal.example");
    expect(conteudo).not.toContain("*");
    const linha = conteudo!.split("\n").find((l) => l.startsWith("Mensagem que disparou"))!;
    const citado = linha.slice(linha.indexOf('"') + 1, linha.lastIndexOf('"'));
    expect([...citado].length).toBeLessThanOrEqual(TETO_DO_TRECHO_DO_CLIENTE);
    expect(citado.endsWith("…")).toBe(true);
    // A aspa do cliente não fecha a nossa citação.
    expect(conteudo).toContain(`respondeu "olha 'isso'"`);
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
      sondagem: { respondeu: false, minutos: 10 },
    });
    expect(partes[0]).toContain("la atención pasó a ti");
    expect(partes[0]).toContain("Mensaje que lo activó");
    expect(partes[0]).toContain("Evaluación de la IA: probable broma (78%)");
    expect(partes[0]).toContain("sin respuesta en 10 min");
    expect(partes[0]).not.toContain("Avaliação");
    expect(partes[1]).toContain("Abrir: ");
  });

  it("a marca vem de fora", () => {
    expect(montarPartesDoAvisoDePassagem({ ...BASE, marca: "Zap do João" })[0]).toContain(
      "🔔 Zap do João:",
    );
  });
});
