/**
 * O AVISO DE CASO EM PARTES (fork elllo) — o que cada mensagem diz, e em que ordem.
 *
 * Com «Responder casos por este WhatsApp» ligado, o aviso sai em sete
 * mensagens: o corpo, o link, e cada instrução separada do seu comando. O
 * comando sozinho num balão é o que a equipe consegue COPIAR com um toque no
 * celular — e o id do caso tem 36 caracteres.
 *
 * Desligado, nada muda: uma mensagem só, idêntica byte a byte ao texto de
 * `montarAvisoDeCaso`. É a garantia que o dono pediu — quem não habilitou a
 * resposta por WhatsApp não percebe que o fork existe.
 */
import { describe, expect, it } from "vitest";

import { montarAvisoDeCaso, montarPartesDoAvisoDeCaso } from "@/lib/escalacao/texto-do-aviso";

const CASO = "0b1f7a2e-0000-4000-8000-000000000000";
const LINK = `https://crm.exemplo.com.br/app/ai/cases?caso=${CASO}`;

const BASE = {
  marca: "Acme CRM",
  idioma: "pt-BR" as const,
  kind: "financeiro",
  source: "agent" as const,
  title: "Desconto acima da política",
  summary: "15% de desconto no plano anual",
  blocker: "a política permite até 10%",
  caseId: CASO,
  nomeDoCliente: "Maria Aparecida de Souza",
  link: LINK,
  respostaWhatsappHabilitada: true,
};

describe("montarPartesDoAvisoDeCaso — ligado", () => {
  it("sete partes, na ordem: corpo, link, instrução, RESPONDER, instrução, PERGUNTAR, fecho", () => {
    const partes = montarPartesDoAvisoDeCaso(BASE);
    expect(partes).toHaveLength(7);
    expect(partes[0]).toBe(
      [
        "🔔 Acme CRM: novo caso esperando você",
        "",
        "Tipo: Pagamento",
        "Assunto: Desconto acima da política",
        "Cliente: Maria",
        "O que o cliente precisa: 15% de desconto no plano anual",
        "Por que a IA travou: a política permite até 10%",
      ].join("\n"),
    );
    expect(partes[1]).toBe(`Abrir: ${LINK}`);
    expect(partes[2]).toBe("Para orientar a IA sem falar diretamente com o cliente, envie:");
    expect(partes[3]).toBe(`RESPONDER ${CASO} <resposta ou decisão>`);
    expect(partes[4]).toBe("Para pedir que a IA esclareça algo com o cliente, envie:");
    expect(partes[5]).toBe(`PERGUNTAR ${CASO} <pergunta ao cliente>`);
    expect(partes[6]).toBe("A IA usa sua orientação e o histórico para continuar o atendimento.");
  });

  it("os comandos saem SOZINHOS no balão, com o id completo — é o que se copia com um toque", () => {
    const partes = montarPartesDoAvisoDeCaso(BASE);
    const comandos = partes.filter((p) => /^(RESPONDER|PERGUNTAR) /.test(p));
    expect(comandos).toEqual([
      `RESPONDER ${CASO} <resposta ou decisão>`,
      `PERGUNTAR ${CASO} <pergunta ao cliente>`,
    ]);
    for (const c of comandos) expect(c).not.toContain("\n");
  });

  it("nenhuma parte é vazia e o conteúdo é o mesmo do aviso inteiro, só redistribuído", () => {
    const partes = montarPartesDoAvisoDeCaso(BASE);
    for (const p of partes) expect(p.trim().length).toBeGreaterThan(0);
    const inteiro = montarAvisoDeCaso(BASE);
    for (const p of partes) expect(inteiro).toContain(p);
  });

  it("NÃO leva telefone, CPF nem URL escrita pelo lead em parte nenhuma", () => {
    const partes = montarPartesDoAvisoDeCaso({
      ...BASE,
      title: "Cliente 529.982.247-25 no +55 31 99896-6398 quer desconto https://mal.example/x",
      summary: "ele disse: 'meu cpf é 529.982.247-25, me liga no 31998966398'",
    });
    const tudo = partes.join("\n");
    expect(tudo).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
    expect(tudo).not.toContain("998966398");
    expect(tudo).not.toContain("mal.example");
    expect(tudo).toContain(LINK);
  });

  it("espanhol: as frases fixas de toda parte são traduzidas; os comandos não", () => {
    const partes = montarPartesDoAvisoDeCaso({ ...BASE, idioma: "es" });
    expect(partes[0]).toContain("nuevo caso esperando por ti");
    expect(partes[2]).toBe("Para orientar a la IA sin hablar directamente con el cliente, envía:");
    expect(partes[3]).toBe(`RESPONDER ${CASO} <resposta ou decisão>`);
    expect(partes[4]).toBe("Para pedirle a la IA que aclare algo con el cliente, envía:");
    expect(partes[6]).toBe("La IA usa tu indicación y el historial para continuar la atención.");
  });
});

describe("montarPartesDoAvisoDeCaso — desligado", () => {
  it("uma parte só, idêntica byte a byte a montarAvisoDeCaso", () => {
    const aviso = { ...BASE, respostaWhatsappHabilitada: false };
    expect(montarPartesDoAvisoDeCaso(aviso)).toEqual([montarAvisoDeCaso(aviso)]);
  });

  it("sem a opção informada vale o padrão (desligado)", () => {
    const { respostaWhatsappHabilitada: _omitida, ...semOpcao } = BASE;
    expect(montarPartesDoAvisoDeCaso(semOpcao)).toEqual([montarAvisoDeCaso(semOpcao)]);
    expect(montarPartesDoAvisoDeCaso(semOpcao)[0]).toContain(
      "Responder aqui não chega ao cliente — abra o link para responder.",
    );
  });

  it("o texto inteiro de hoje não mudou com a extração do corpo", () => {
    expect(montarAvisoDeCaso({ ...BASE, respostaWhatsappHabilitada: false })).toBe(
      [
        "🔔 Acme CRM: novo caso esperando você",
        "",
        "Tipo: Pagamento",
        "Assunto: Desconto acima da política",
        "Cliente: Maria",
        "O que o cliente precisa: 15% de desconto no plano anual",
        "Por que a IA travou: a política permite até 10%",
        "",
        `Abrir: ${LINK}`,
        "",
        "Responder aqui não chega ao cliente — abra o link para responder.",
      ].join("\n"),
    );
  });
});
