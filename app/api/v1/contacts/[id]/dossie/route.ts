import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { criarNotaSchema } from "@/lib/dossie/escrita-da-tela";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * O DOSSIÊ DO CONTATO pela tela — escrever uma linha (fork elllo, migration 9005).
 *
 * O que a tela escreve é sempre fonte `lucas`: quem está aqui é a empresa contando
 * algo do contato. A linha entra no prompt da Helô como contexto "só para você"; a
 * cerca `nota_do_lucas` barra a resposta que repete o texto dela ao contato, a não
 * ser com `liberada` ("pode usar com ele"). Ler é pelo `crm-summary` (seção
 * Memória do contato); corrigir e apagar, em `dossie/[noteId]`.
 *
 * `manager`, como a marca de atendimento humano: é a ficha que o agente usa.
 */
export async function POST(req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("manager", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  if (!z.uuid().safeParse(id).success) {
    return fail("validation_failed", t("Contato inválido."), 422, { requestId });
  }
  const parsed = criarNotaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Nota inválida: título, texto e categoria."), 422, { requestId });
  }

  const orgId = authz.org.orgId;
  const admin = createAdminClient();
  // Admin client bypassa RLS: o filtro por organização é PROGRAMÁTICO e obrigatório.
  const { data: contato, error: leituraErro } = await admin
    .from("contacts")
    .select("id, is_anonymized")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (leituraErro) return fail("internal_error", t("Não foi possível salvar a nota."), 500, { requestId });
  if (!contato) return fail("not_found", t("Contato não encontrado."), 404, { requestId });
  if ((contato as { is_anonymized?: boolean }).is_anonymized === true) {
    return fail("conflict", t("Contato anonimizado: o dossiê não aceita notas."), 409, { requestId });
  }

  const { data: nota, error } = await admin
    .from("lead_notes")
    .insert({
      organization_id: orgId,
      contact_id: id,
      headline: parsed.data.headline,
      body: parsed.data.body,
      categoria: parsed.data.categoria,
      fonte: "lucas",
      liberada: parsed.data.liberada ?? false,
    })
    .select("id, headline, body, categoria, fonte, liberada")
    .single();
  if (error || !nota) return fail("internal_error", t("Não foi possível salvar a nota."), 500, { requestId });

  await audit({
    action: "contacts.dossie_nota_criada",
    actorUserId: authz.user.id,
    actorApiTokenId: null,
    organizationId: orgId,
    resourceType: "contact",
    resourceId: id,
    requestId,
    // Sem o texto: auditoria é append-only e a anonimização não a alcança.
    metadata: { contact_id: id, nota_id: nota.id, categoria: nota.categoria, fonte: "lucas", liberada: nota.liberada },
  });
  return ok({ data: nota }, { requestId });
}
