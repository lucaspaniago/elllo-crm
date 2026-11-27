import { describe, expect, it } from "vitest";
import {
  FRASE_AO_CLIENTE_EM_PEDIDO_SOBRE_CASO_ABERTO,
  FRASE_DA_HELO_EM_PEDIDO_SOBRE_CASO_ABERTO,
  recusaDeCasoAberto,
} from "@/lib/agent-engine/agent/human-cases";

const mensagem = (r: ReturnType<typeof recusaDeCasoAberto>) => (r.ok ? "" : r.error.message);

describe("recusa de caso aberto (sondar1)", () => {
  it("opção desligada: a recusa de sempre, byte a byte", () => {
    expect(recusaDeCasoAberto()).toEqual(recusaDeCasoAberto(false));
    expect(mensagem(recusaDeCasoAberto())).toContain(FRASE_AO_CLIENTE_EM_PEDIDO_SOBRE_CASO_ABERTO);
    expect(mensagem(recusaDeCasoAberto())).toContain("Aguarde a resposta do atendente");
  });
  it("na voz da Helô: mesma guarda, sem cerca falada ao cliente", () => {
    const r = recusaDeCasoAberto(true);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("case_already_open");
    expect(r.error.message).toContain(FRASE_DA_HELO_EM_PEDIDO_SOBRE_CASO_ABERTO);
    expect(r.error.message).not.toContain("não consigo te dar um prazo");
    expect(r.error.message).toContain("NÃO diga ao cliente que alguém foi acionado");
    expect(r.error.message).toContain("Se a mensagem não pede resposta, não responda");
    expect(FRASE_DA_HELO_EM_PEDIDO_SOBRE_CASO_ABERTO).not.toMatch(/prazo|garant|não consigo|não posso|registrad/i);
  });
});
