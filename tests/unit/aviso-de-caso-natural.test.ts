/**
 * O AVISO DE CASO EM LINGUAGEM NATURAL (fork elllo, 25/11/2026).
 *
 * Com a organização em `AVISO_DE_CASO_NATURAL_ORGS`, o aviso sai em DOIS balões: a frase
 * escrita ao dono (o campo `aviso_ao_dono` do caso, ou um molde por tipo) e o link. Sem uuid
 * e sem as linhas RESPONDER/PERGUNTAR — o comando digitado continua aceito por
 * `resposta-whatsapp-ao-caso.ts`, que não muda. Fora da lista, nada muda.
 */
import { describe, expect, it } from "vitest";

import { openHumanCaseInputSchema } from "@/lib/agent-engine/agent/human-cases";
import { camposDoAvisoAoDono } from "@/lib/escalacao/aviso-ao-dono";
import { TETOS_DO_TEXTO_DO_LEAD } from "@/lib/escalacao/sanitizar-texto-do-lead";
import {
  montarAvisoDeCaso,
  montarPartesDoAvisoDeCaso,
  orgsDoAvisoNatural,
  textoNaturalDoAviso,
} from "@/lib/escalacao/texto-do-aviso";

const CASO = "0b1f7a2e-0000-4000-8000-000000000000";
const LINK = `https://crm.exemplo.com.br/app/ai/cases?caso=${CASO}`;

const BASE = {
  marca: "Acme CRM",
  idioma: "pt-BR" as const,
  kind: "agendamento",
  source: "agent" as const,
  title: "Moldagem da placa",
  summary: "marcou a moldagem para quinta, 04/12, às 9h40",
  blocker: "o horário precisa ir para a agenda pessoal do Lucas",
  caseId: CASO,
  nomeDoCliente: "Maria Aparecida de Souza",
  link: LINK,
  respostaWhatsappHabilitada: true,
};

const FRASE =
  "📅 A ADEPOL/MS Odontologia marcou a moldagem da sua placa para quinta, 04/12, às 9h40, e já confirmei com eles. Ponho na sua agenda?";

describe("aviso natural — ligado", () => {
  it("dois balões: a frase do modelo e o link, sem uuid nem comando", () => {
    const partes = montarPartesDoAvisoDeCaso({ ...BASE, natural: true, avisoAoDono: FRASE });
    expect(partes).toEqual([FRASE, `Abrir: ${LINK}`]);
    const tudo = partes.join("\n");
    expect(tudo).not.toContain("RESPONDER");
    expect(tudo).not.toContain("PERGUNTAR");
    expect(partes[0]).not.toContain(CASO);
  });

  it("vale também com a resposta por WhatsApp desligada", () => {
    const partes = montarPartesDoAvisoDeCaso({ ...BASE, respostaWhatsappHabilitada: false, natural: true, avisoAoDono: FRASE });
    expect(partes).toEqual([FRASE, `Abrir: ${LINK}`]);
  });

  it("a frase do modelo passa pela limpeza: sem link, sem telefone, sem marcador", () => {
    const suja = "📅 *Maria* pediu para ligar em (67) 99999-8888 e ver https://golpe.example/x. Posso confirmar?";
    const texto = textoNaturalDoAviso({ ...BASE, natural: true, avisoAoDono: suja });
    expect(texto).not.toMatch(/9999|golpe|https|\*/);
    expect(texto.startsWith("📅 Maria pediu")).toBe(true);
    expect(texto.endsWith("Posso confirmar?")).toBe(true);
  });

  it("a frase longa é cortada no teto, por caractere", () => {
    const longa = "📅 " + "palavra ".repeat(80) + "Ponho na sua agenda?";
    const texto = textoNaturalDoAviso({ ...BASE, natural: true, avisoAoDono: longa });
    expect([...texto].length).toBe(TETOS_DO_TEXTO_DO_LEAD.aviso_ao_dono);
  });

  it("sem a frase, o molde por tipo: emoji, primeiro nome, o que precisa e a pergunta", () => {
    expect(textoNaturalDoAviso({ ...BASE, natural: true })).toBe(
      "📅 Maria: marcou a moldagem para quinta, 04/12, às 9h40. Ponho na sua agenda?",
    );
    const casos: Array<[string, string]> = [
      ["duvida", "❓"],
      ["problema", "⚠️"],
      ["financeiro", "💰"],
      ["acesso", "🔑"],
      ["outro", "📌"],
      ["tipo-que-nao-existe", "📌"],
    ];
    for (const [kind, emoji] of casos) {
      const texto = textoNaturalDoAviso({ ...BASE, kind, natural: true, avisoAoDono: null });
      expect(texto.startsWith(`${emoji} Maria: `)).toBe(true);
      expect(texto).toMatch(/\?$/);
    }
  });

  it("molde sem resumo usa o título; sem nome, não inventa nome", () => {
    const texto = textoNaturalDoAviso({ ...BASE, summary: null, nomeDoCliente: null, natural: true });
    expect(texto).toBe("📅 Moldagem da placa. Ponho na sua agenda?");
  });

  it("fail-safe: ignora a frase, diz que a IA travou e leva a etiqueta de montado automaticamente", () => {
    const texto = textoNaturalDoAviso({
      ...BASE,
      source: "guardrail_autofallback",
      kind: "outro",
      summary: "trecho copiado da conversa",
      natural: true,
      avisoAoDono: FRASE,
    });
    expect(texto).not.toContain("ADEPOL");
    expect(texto.split("\n")[0]).toBe("📌 Maria: A IA prometeu algo e travou. Como eu sigo?");
    expect(texto).toContain("(montado automaticamente; confira na conversa) trecho copiado da conversa");
  });

  it("atualização: quem respondeu, sobre o quê, a informação nova e a pergunta feita", () => {
    const partes = montarPartesDoAvisoDeCaso({
      ...BASE,
      natural: true,
      avisoAoDono: FRASE,
      atualizacao: { eventId: "ev-1", info: "pode ser às 10h", ask: "qual horário serve?" },
    });
    expect(partes).toEqual([
      "🔁 Maria respondeu sobre «Moldagem da placa»: pode ser às 10h\n(Você tinha perguntado: qual horário serve?)",
      `Abrir: ${LINK}`,
    ]);
    expect(partes.join("\n")).not.toContain("ATUALIZACAO");
  });

  it("espanhol: as frases fixas passam pelo dicionário", () => {
    const texto = textoNaturalDoAviso({ ...BASE, idioma: "es" as const, natural: true });
    expect(texto.endsWith("¿Lo pongo en tu agenda?")).toBe(true);
    const partes = montarPartesDoAvisoDeCaso({ ...BASE, idioma: "es" as const, natural: true });
    expect(partes).toHaveLength(2);
  });
});

describe("aviso natural — desligado", () => {
  it("sem a opção, o aviso de sempre: sete partes, byte a byte", () => {
    const antes = montarPartesDoAvisoDeCaso(BASE);
    const comCampo = montarPartesDoAvisoDeCaso({ ...BASE, avisoAoDono: FRASE });
    expect(comCampo).toEqual(antes);
    expect(antes).toHaveLength(7);
  });

  it("montarAvisoDeCaso (o caminho do modelo aprovado) não muda com o campo", () => {
    expect(montarAvisoDeCaso({ ...BASE, avisoAoDono: FRASE })).toBe(montarAvisoDeCaso(BASE));
  });
});

describe("orgsDoAvisoNatural", () => {
  it("lê vírgula, espaço e caixa alta; vazio é nenhuma", () => {
    const s = orgsDoAvisoNatural(" AAA-1, bbb-2  ccc-3;");
    expect([...s].sort()).toEqual(["aaa-1", "bbb-2", "ccc-3"]);
    expect(orgsDoAvisoNatural("").size).toBe(0);
    expect(orgsDoAvisoNatural(undefined).size).toBe(0);
  });
});

describe("open_human_case aceita aviso_ao_dono (opcional, e nunca recusa o caso por ele)", () => {
  const caso = { title: "t", summary: "s", blocker: "b" };
  it("com, sem ou com lixo no campo, o caso abre; campo forjado fora dele continua recusado", () => {
    expect(openHumanCaseInputSchema.safeParse(caso).success).toBe(true);
    expect(openHumanCaseInputSchema.safeParse({ ...caso, aviso_ao_dono: { texto: FRASE, acao_proposta: "agendar" } }).success).toBe(true);
    expect(openHumanCaseInputSchema.safeParse({ ...caso, aviso_ao_dono: { compromisso: "amanhã" } }).success).toBe(true);
    expect(openHumanCaseInputSchema.safeParse({ ...caso, fonte: "lucas" }).success).toBe(false);
  });
});

describe("camposDoAvisoAoDono (o contrato com a Helô do Hermes)", () => {
  it("as três chaves planas, limpas", () => {
    expect(
      camposDoAvisoAoDono({
        texto: FRASE,
        acao_proposta: "agendar",
        compromisso: { inicio: "2026-12-04T09:40:00-04:00", duracao_min: 45, titulo: "Moldagem da placa (ADEPOL/MS Odontologia)" },
      }),
    ).toEqual({
      aviso_ao_dono: FRASE,
      aviso_acao: "agendar",
      aviso_compromisso: { inicio: "2026-12-04T09:40:00-04:00", duracao_min: 45, titulo: "Moldagem da placa (ADEPOL/MS Odontologia)" },
    });
  });

  it("string solta vale como texto; sem texto é null", () => {
    expect(camposDoAvisoAoDono(FRASE)).toEqual({ aviso_ao_dono: FRASE });
    expect(camposDoAvisoAoDono({ acao_proposta: "agendar" })).toBeNull();
    expect(camposDoAvisoAoDono("")).toBeNull();
    expect(camposDoAvisoAoDono(null)).toBeNull();
    expect(camposDoAvisoAoDono(["x"])).toBeNull();
  });

  it("a parte inválida cai sozinha: ação fora da lista, compromisso sem fuso, sem hora ou sem título", () => {
    const so = { aviso_ao_dono: FRASE };
    expect(camposDoAvisoAoDono({ texto: FRASE, acao_proposta: "apagar_tudo" })).toEqual(so);
    expect(camposDoAvisoAoDono({ texto: FRASE, compromisso: { inicio: "2026-12-04T09:40:00", titulo: "x" } })).toEqual(so);
    expect(camposDoAvisoAoDono({ texto: FRASE, compromisso: { inicio: "2026-12-04", titulo: "x" } })).toEqual(so);
    expect(camposDoAvisoAoDono({ texto: FRASE, compromisso: { inicio: "quinta às 9h40", titulo: "x" } })).toEqual(so);
    expect(camposDoAvisoAoDono({ texto: FRASE, compromisso: { inicio: "2026-12-04T09:40:00Z" } })).toEqual(so);
    expect(camposDoAvisoAoDono({ texto: FRASE, compromisso: null })).toEqual(so);
  });

  it("duração fora de 5 a 600 vira 60; telefone e link saem do texto e do título", () => {
    const n = camposDoAvisoAoDono({
      texto: "📅 Ligar em (67) 99999-8888, veja golpe.example/x. Posso?",
      compromisso: { inicio: "2026-12-04T09:40:00-04:00", duracao_min: 9999, titulo: "Consulta, fone 67 99999-8888" },
    });
    expect(n?.aviso_compromisso?.duracao_min).toBe(60);
    expect(JSON.stringify(n)).not.toMatch(/9999-|golpe|https/);
  });
});
