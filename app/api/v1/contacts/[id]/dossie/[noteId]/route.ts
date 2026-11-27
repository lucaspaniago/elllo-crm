import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { aplicarCorrecao, corrigirNotaSchema, type NotaAtual } from "@/lib/dossie/escrita-da-tela";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; noteId: string }> };

/**
 * O DOSSIÊ DO CONTATO pela tela — corrigir e apagar uma linha (fork elllo, 9005).
 *
 * A linha é sempre buscada por (organização, contato, nota): uma nota de outro
 * contato, ou de outra organização, é 404 — nunca uma escrita cruzada. Corrigir mantém
 * a fonte (ver `aplicarCorrecao`); o texto novo zera o embedding do recall.
 */
export async function PATCH(req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id, noteId } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(noteId).success) {
    return fail("validation_failed", t("Nota inválida."), 422, { requestId });
  }
  const parsed = corrigirNotaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Nota inválida."), 422, { requestId });

  const orgId = authz.org.orgId;
  const admin = createAdminClient();
  const { data: atual, error: leituraErro } = await admin
    .from("lead_notes")
    .select("id, categoria, fonte, liberada")
    .eq("organization_id", orgId)
    .eq("contact_id", id)
    .eq("id", noteId)
    .maybeSingle();
  if (leituraErro) return fail("internal_error", t("Não foi possível corrigir a nota."), 500, { requestId });
  if (!atual) return fail("not_found", t("Nota não encontrada."), 404, { requestId });

  const correcao = aplicarCorrecao(atual as unknown as NotaAtual, parsed.data);
  if (!correcao.ok) {
    return fail("validation_failed", t("Só o que a equipe contou pode ser liberado para usar com o contato."), 422, {
      requestId,
    });
  }
  const { data: nota, error } = await admin
    .from("lead_notes")
    .update(correcao.valores)
    .eq("organization_id", orgId)
    .eq("contact_id", id)
    .eq("id", noteId)
    .select("id, headline, body, categoria, fonte, liberada")
    .maybeSingle();
  if (error || !nota) return fail("internal_error", t("Não foi possível corrigir a nota."), 500, { requestId });

  await audit({
    action: "contacts.dossie_nota_corrigida",
    actorUserId: authz.user.id,
    actorApiTokenId: null,
    organizationId: orgId,
    resourceType: "contact",
    resourceId: id,
    requestId,
    metadata: {
      contact_id: id,
      nota_id: noteId,
      campos: Object.keys(parsed.data).sort().join(","),
      categoria: nota.categoria,
      fonte: nota.fonte,
      liberada: nota.liberada,
    },
  });
  return ok({ data: nota }, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id, noteId } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(noteId).success) {
    return fail("validation_failed", t("Nota inválida."), 422, { requestId });
  }

  const orgId = authz.org.orgId;
  const { data: apagada, error } = await createAdminClient()
    .from("lead_notes")
    .delete()
    .eq("organization_id", orgId)
    .eq("contact_id", id)
    .eq("id", noteId)
    .select("id, categoria, fonte")
    .maybeSingle();
  if (error) return fail("internal_error", t("Não foi possível apagar a nota."), 500, { requestId });
  if (!apagada) return fail("not_found", t("Nota não encontrada."), 404, { requestId });

  await audit({
    action: "contacts.dossie_nota_apagada",
    actorUserId: authz.user.id,
    actorApiTokenId: null,
    organizationId: orgId,
    resourceType: "contact",
    resourceId: id,
    requestId,
    metadata: { contact_id: id, nota_id: noteId, categoria: apagada.categoria, fonte: apagada.fonte },
  });
  return ok({ data: { id: noteId } }, { requestId });
}
