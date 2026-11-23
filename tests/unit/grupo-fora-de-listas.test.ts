import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { webPushInboundHandler } from "@/lib/notifications/push.handler";
import { GRUPO_PELO_JEV_HANDLER_KEY } from "@/lib/escalacao/grupo-pelo-jev.handler";
import { ensureHandlersRegistered } from "@/lib/event-log/register-handlers";

describe("grupos: quem escuta e quem não escuta", () => {
  it("a notificação do atendente escuta mensagem de grupo", () => {
    expect(webPushInboundHandler.events).toContain("message.group_received");
  });

  it("nenhum outro consumidor registrado escuta message.group_received", async () => {
    const { getRegisteredHandlers } = await import("@/lib/event-log/dispatcher");
    ensureHandlersRegistered();
    const escutam = getRegisteredHandlers()
      .filter((h) => h.events.includes("message.group_received"))
      .map((h) => h.key)
      .sort();
    // Fork elllo: o Jev lê a mensagem de grupo para o apanhado do dono e NUNCA
    // responde (o teste abaixo trava o que ele pode importar).
    expect(escutam).toEqual([GRUPO_PELO_JEV_HANDLER_KEY, webPushInboundHandler.key].sort());
  });

  it("o consumidor do Jev só lê e grava o item: nenhum módulo que envia", () => {
    const fonte = readFileSync("lib/escalacao/grupo-pelo-jev.handler.ts", "utf8");
    const modulos = [...fonte.matchAll(/(?:from\s+|import\(\s*)["']([^"']+)["']/g)].map((m) => m[1]!).sort();
    expect(modulos).toEqual(
      [
        "@/lib/contacts/rotulo-do-contato",
        "@/lib/event-log/dispatcher",
        "@/lib/lgpd/cascata",
        "@/lib/supabase/admin",
        "./grupos-pelo-jev",
        "./itens-do-apanhado",
        "./jev-do-fork",
      ].sort(),
    );
  });

  it("listagem de contatos e audiência de campanha excluem o contato de grupo", () => {
    for (const arquivo of ["app/api/v1/contacts/_handler.ts", "lib/campanhas/consulta-de-audiencia.ts"]) {
      expect(readFileSync(arquivo, "utf8"), arquivo).toMatch(/\.eq\(\s*["']kind["']\s*,\s*["']person["']\s*\)/);
    }
  });
});
