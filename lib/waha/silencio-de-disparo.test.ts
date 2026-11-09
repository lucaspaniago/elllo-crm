import { describe, expect, it, vi } from "vitest";

// silencio-de-disparo.ts importa @/lib/audit (→ supabase/server → validação de env).
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

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
