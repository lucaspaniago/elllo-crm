import { describe, expect, it, vi } from "vitest";

// silencio-de-disparo.ts importa @/lib/audit (→ supabase/server → validação de env).
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

import { ETIQUETA_DO_SILENCIO } from "@/lib/escalacao/tolerancia-ao-sentimento";
import type { DisparoAutomatico } from "@/lib/waha/disparo-automatico";
import {
  ETIQUETA_DE_PROPAGANDA,
  silenciarDisparoAutomatico,
  silencioDeDisparosLigado,
  type PortaDoSilencio,
} from "@/lib/waha/silencio-de-disparo";

/**
 * Fork elllo — a orquestração do silêncio com o banco trocado por uma porta de
 * mentira. A ligação com o webhook de verdade está em
 * `lib/waha/ingest-disparo-automatico.test.ts`.
 */

const DISPARO: DisparoAutomatico = { automatico: true, tipo: "template", texto: "Promoção", empresa: "Loja X" };

function porta(sobre: Partial<PortaDoSilencio> = {}) {
  const chamadas: string[] = [];
  const p: PortaDoSilencio = {
    settingsDaOrganizacao: vi.fn(async () => ({})),
    jaEscrevemosAoContato: vi.fn(async () => false),
    contatoPessoal: vi.fn(async () => false),
    etiquetarContato: vi.fn(async (_o, _c, etiqueta) => void chamadas.push(`etiqueta:${etiqueta}`)),
    encerrarConversa: vi.fn(async () => void chamadas.push("conversa")),
    encerrarNegociosAbertos: vi.fn(async () => void chamadas.push("negocios")),
    ...sobre,
  };
  return { p, chamadas };
}

const ENTRADA = {
  organizationId: "org-1",
  contactId: "contato-1",
  conversationId: "conversa-1",
  messageId: "msg-1",
  disparo: DISPARO,
  requestId: "req-1",
};

describe("silencioDeDisparosLigado — padrão LIGADO, só o booleano false desliga", () => {
  it.each([
    [null, true],
    [{}, true],
    [{ crm: {} }, true],
    [{ crm: { silenciar_disparos_automaticos: true } }, true],
    [{ crm: { silenciar_disparos_automaticos: "false" } }, true],
    [{ crm: "torto" }, true],
    [{ crm: { silenciar_disparos_automaticos: false } }, false],
  ])("%j → %s", (settings, esperado) => {
    expect(silencioDeDisparosLigado(settings)).toBe(esperado);
  });
});

describe("silenciarDisparoAutomatico", () => {
  it("propaganda a quem nunca escrevemos: etiqueta, encerra a conversa e os cards — e devolve true", async () => {
    const { p, chamadas } = porta();
    await expect(silenciarDisparoAutomatico({} as never, ENTRADA, p)).resolves.toBe(true);
    expect(chamadas).toEqual([`etiqueta:${ETIQUETA_DE_PROPAGANDA}`, "conversa", "negocios"]);
    expect(ETIQUETA_DE_PROPAGANDA).toBe("propaganda");
    // A tolerância ao sentimento reconhece o silêncio por esta etiqueta (cópia).
    expect(ETIQUETA_DO_SILENCIO).toBe(ETIQUETA_DE_PROPAGANDA);
  });

  it("mensagem de gente: nem consulta o banco", async () => {
    const { p } = porta();
    await expect(silenciarDisparoAutomatico({} as never, { ...ENTRADA, disparo: null }, p)).resolves.toBe(false);
    expect(p.settingsDaOrganizacao).not.toHaveBeenCalled();
  });

  it("desligado: segue como hoje, sem efeito e sem procurar envio nosso", async () => {
    const { p, chamadas } = porta({
      settingsDaOrganizacao: vi.fn(async () => ({ crm: { silenciar_disparos_automaticos: false } })),
    });
    await expect(silenciarDisparoAutomatico({} as never, ENTRADA, p)).resolves.toBe(false);
    expect(p.jaEscrevemosAoContato).not.toHaveBeenCalled();
    expect(chamadas).toEqual([]);
  });

  it("nós escrevemos primeiro: segue como hoje", async () => {
    const { p, chamadas } = porta({ jaEscrevemosAoContato: vi.fn(async () => true) });
    await expect(silenciarDisparoAutomatico({} as never, ENTRADA, p)).resolves.toBe(false);
    expect(chamadas).toEqual([]);
  });

  it("contato pessoal: segue como hoje (sem etiqueta de propaganda)", async () => {
    const { p, chamadas } = porta({ contatoPessoal: vi.fn(async () => true) });
    await expect(silenciarDisparoAutomatico({} as never, ENTRADA, p)).resolves.toBe(false);
    expect(chamadas).toEqual([]);
  });

  it("leitura que falha antes da decisão: NÃO silencia (a IA atende, como hoje)", async () => {
    const { p, chamadas } = porta({
      jaEscrevemosAoContato: vi.fn(async () => {
        throw new Error("timeout");
      }),
    });
    await expect(silenciarDisparoAutomatico({} as never, ENTRADA, p)).resolves.toBe(false);
    expect(chamadas).toEqual([]);
  });

  it("efeito que falha depois da decisão: os outros seguem e a mensagem continua silenciada", async () => {
    const { p, chamadas } = porta({
      etiquetarContato: vi.fn(async () => {
        throw new Error("rpc caiu");
      }),
    });
    await expect(silenciarDisparoAutomatico({} as never, ENTRADA, p)).resolves.toBe(true);
    expect(chamadas).toEqual(["conversa", "negocios"]);
  });
});

describe("silenciarDisparoAutomatico — o Jev quando a forma não denuncia (fork elllo, 16/11/2026)", () => {
  const ECAD =
    "*RASGUE O BOLETO. NÃO O SEU LUCRO!* Sua academia ainda paga ECAD para tocar música? 😱 Você sabia que esse custo retira R$ 5 MIL até R$ 25 MIL de lucro em 5 anos?";
  const SEM_FORMA = { ...ENTRADA, disparo: null, texto: ECAD };

  function comJev(resposta: { propaganda: boolean; probabilidade: number } | null, sobre: Partial<PortaDoSilencio> = {}) {
    const itens: unknown[] = [];
    const base = porta({
      propagandaPeloJev: vi.fn(async () => resposta),
      registrarNoApanhado: vi.fn(async (item) => void itens.push(item)),
      ...sobre,
    });
    return { ...base, itens };
  }

  it("propaganda clara pelo Jev: os mesmos efeitos do disparo, e entra no apanhado com origem jev", async () => {
    const { p, chamadas, itens } = comJev({ propaganda: true, probabilidade: 0.97 });
    await expect(silenciarDisparoAutomatico({} as never, SEM_FORMA, p)).resolves.toBe(true);
    expect(chamadas).toEqual([`etiqueta:${ETIQUETA_DE_PROPAGANDA}`, "conversa", "negocios"]);
    expect(itens).toEqual([
      {
        organizationId: "org-1",
        tipo: "propaganda",
        origem: "jev",
        messageId: "msg-1",
        conversationId: "conversa-1",
        probabilidade: 0.97,
      },
    ]);
  });

  it("o Jev não viu propaganda (ou não decidiu): segue como hoje, sem efeito", async () => {
    for (const resposta of [{ propaganda: false, probabilidade: 0.4 }, null]) {
      const { p, chamadas, itens } = comJev(resposta);
      await expect(silenciarDisparoAutomatico({} as never, SEM_FORMA, p)).resolves.toBe(false);
      expect(chamadas).toEqual([]);
      expect(itens).toEqual([]);
    }
  });

  it("nós já escrevemos ao contato: o Jev nem é perguntado", async () => {
    const { p } = comJev({ propaganda: true, probabilidade: 0.99 }, { jaEscrevemosAoContato: vi.fn(async () => true) });
    await expect(silenciarDisparoAutomatico({} as never, SEM_FORMA, p)).resolves.toBe(false);
    expect(p.propagandaPeloJev).not.toHaveBeenCalled();
  });

  it("silêncio desligado ou contato pessoal: o Jev nem é perguntado", async () => {
    const desligado = comJev(
      { propaganda: true, probabilidade: 0.99 },
      { settingsDaOrganizacao: vi.fn(async () => ({ crm: { silenciar_disparos_automaticos: false } })) },
    );
    await expect(silenciarDisparoAutomatico({} as never, SEM_FORMA, desligado.p)).resolves.toBe(false);
    expect(desligado.p.propagandaPeloJev).not.toHaveBeenCalled();
    const pessoal = comJev({ propaganda: true, probabilidade: 0.99 }, { contatoPessoal: vi.fn(async () => true) });
    await expect(silenciarDisparoAutomatico({} as never, SEM_FORMA, pessoal.p)).resolves.toBe(false);
    expect(pessoal.p.propagandaPeloJev).not.toHaveBeenCalled();
  });

  it("texto curto ('oi, tudo bem?'): nem banco, nem Jev", async () => {
    const { p } = comJev({ propaganda: true, probabilidade: 0.99 });
    await expect(silenciarDisparoAutomatico({} as never, { ...SEM_FORMA, texto: "oi, tudo bem?" }, p)).resolves.toBe(false);
    expect(p.settingsDaOrganizacao).not.toHaveBeenCalled();
    expect(p.propagandaPeloJev).not.toHaveBeenCalled();
  });

  it("o disparo pela forma também entra no apanhado, com origem disparo_automatico e sem probabilidade", async () => {
    const { p, itens } = comJev(null);
    await expect(silenciarDisparoAutomatico({} as never, ENTRADA, p)).resolves.toBe(true);
    expect(p.propagandaPeloJev).not.toHaveBeenCalled();
    expect(itens).toEqual([expect.objectContaining({ origem: "disparo_automatico", probabilidade: null })]);
  });

  it("o apanhado que falha não desfaz o silêncio", async () => {
    const { p, chamadas } = comJev(
      { propaganda: true, probabilidade: 0.95 },
      {
        registrarNoApanhado: vi.fn(async () => {
          throw new Error("tabela fora");
        }),
      },
    );
    await expect(silenciarDisparoAutomatico({} as never, SEM_FORMA, p)).resolves.toBe(true);
    expect(chamadas).toEqual([`etiqueta:${ETIQUETA_DE_PROPAGANDA}`, "conversa", "negocios"]);
  });
});
