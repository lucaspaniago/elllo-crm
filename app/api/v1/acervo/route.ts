/**
 * POST /api/v1/acervo — o ACERVO de peças da loja pelo mensageiro do Hermes (fork elllo, acervo1).
 *
 * Quem chama é o mensageiro, por TOKEN (`dsk_…` com `mcp:write`); sessão de navegador é
 * recusada (403). A organização sai da linha do token, nunca do corpo. Só responde na
 * organização listada em `ACERVO_ORGS` (vazia = 404, desligada). Nada aqui manda mensagem.
 *
 * Corpo JSON `{"acao": …}`, ou multipart com o campo `dados` (o mesmo JSON) e os arquivos
 * `fotos` (só em `previa_cadastro`; até 5, JPG ou PNG, até 1600 px no lado maior e 800 KB —
 * quem manda reduz antes, o CRM só confere).
 *
 * Escrita em dois passos (`lib/acervo/acervo.ts`):
 *   - `previa_cadastro` {modelo, cor, tamanho, uso, preco_venda_centavos?, preco_locacao_centavos?,
 *                        descricao?, observacoes?, codigo?}
 *   - `previa_publicar` {codigo, publicar?: true|false}
 *   - `previa_status`   {codigo, status, motivo?}
 *   - `previa_reserva`  {codigo, data_evento: "AAAA-MM-DD", cliente?, observacoes?}
 *   - `previa_cancelar_reserva` {reserva_id}
 *     → `{"ok":true,"id_previa","expira_em","vai_gravar":{…},…}` (nada gravado no acervo)
 *   - `gravar` {id_previa} → `{"ok":true,"acao","repetido",…}` (exatamente o que a prévia mostrou)
 * Leitura (sem prévia):
 *   - `disponibilidade` {data_evento, codigo?, modelo?, cor?, tamanho?, limite?}
 *   - `consultar` {codigo?} ou filtros {modelo?, cor?, tamanho?, uso?, status?, publicada?, limite?}
 * Erro: `{"ok":false,"erro":"<código>","detalhe":"<texto>"}` com HTTP 4xx/5xx.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import {
  acervoLigado,
  consultar,
  disponibilidade,
  gravarPrevia,
  previaCadastro,
  previaCancelarReserva,
  previaPublicar,
  previaReserva,
  previaStatus,
  STATUS,
  USOS,
  type Armazem,
  type Falha,
} from "@/lib/acervo/acervo";
import { FOTO_BYTES_MAXIMO, FOTOS_POR_PECA } from "@/lib/acervo/fotos-do-acervo";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { lerCorpoComTeto } from "@/lib/api/corpo-com-teto";
import { audit } from "@/lib/audit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { BUCKET_DAS_FOTOS } from "@/lib/catalogo/fotos";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const centavos = z.number().int().min(0).max(100_000_000).nullable().optional();
const texto = (max: number) => z.string().max(max).nullable().optional();
const codigo = z.string().min(1).max(40);
const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const filtros = {
  modelo: texto(120),
  cor: texto(60),
  tamanho: texto(30),
  limite: z.number().int().min(1).max(200).optional(),
};
const corpoSchema = z.discriminatedUnion("acao", [
  z.object({
    acao: z.literal("previa_cadastro"),
    codigo: codigo.nullable().optional(),
    modelo: z.string().min(1).max(120),
    cor: z.string().min(1).max(60),
    tamanho: z.string().min(1).max(30),
    uso: z.enum(USOS),
    preco_venda_centavos: centavos,
    preco_locacao_centavos: centavos,
    descricao: texto(1000),
    observacoes: texto(2000),
  }),
  z.object({ acao: z.literal("previa_publicar"), codigo, publicar: z.boolean().optional() }),
  z.object({ acao: z.literal("previa_status"), codigo, status: z.enum(STATUS), motivo: texto(500) }),
  z.object({ acao: z.literal("previa_reserva"), codigo, data_evento: data, cliente: texto(200), observacoes: texto(1000) }),
  z.object({ acao: z.literal("previa_cancelar_reserva"), reserva_id: z.uuid() }),
  z.object({ acao: z.literal("gravar"), id_previa: z.uuid() }),
  z.object({ acao: z.literal("disponibilidade"), data_evento: data, codigo: codigo.nullable().optional(), ...filtros }),
  z.object({
    acao: z.literal("consultar"),
    codigo: codigo.nullable().optional(),
    uso: z.enum(USOS).nullable().optional(),
    status: z.enum(STATUS).nullable().optional(),
    publicada: z.boolean().nullable().optional(),
    ...filtros,
  }),
]);
type Corpo = z.infer<typeof corpoSchema>;

function responder(corpo: Record<string, unknown>, status: number, requestId: string) {
  return NextResponse.json(corpo, { status, headers: { "X-Request-Id": requestId } });
}
const erro = (codigoDoErro: string, status: number, requestId: string, detalhe?: string) =>
  responder({ ok: false, erro: codigoDoErro, ...(detalhe ? { detalhe } : {}) }, status, requestId);
const deFalha = (f: Falha, requestId: string) =>
  responder({ ok: false, erro: f.erro, ...(f.detalhe ? { detalhe: f.detalhe } : {}), ...(f.extra ?? {}) }, f.status, requestId);

function armazemDoStorage(requestId: string): Armazem {
  return {
    async subir(caminho, bytes, tipo) {
      const { error } = await createAdminClient().storage.from(BUCKET_DAS_FOTOS).upload(caminho, bytes, { contentType: tipo, upsert: false });
      if (error) logger.error("[acervo] upload da foto falhou", { detalhe: error.message, requestId });
      return !error;
    },
    async apagar(caminhos) {
      if (caminhos.length === 0) return;
      const { error } = await createAdminClient().storage.from(BUCKET_DAS_FOTOS).remove(caminhos);
      if (error) logger.warn("[acervo] remoção de foto falhou", { detalhe: error.message, requestId });
    },
  };
}

async function lerCorpo(req: NextRequest, requestId: string): Promise<{ ok: true; corpo: Corpo; fotos: Uint8Array[] } | { ok: false; resposta: Response }> {
  const ruim = (detalhe?: string) => ({ ok: false as const, resposta: erro("corpo_invalido", 400, requestId, detalhe) });
  const lido = await lerCorpoComTeto(req, FOTOS_POR_PECA * FOTO_BYTES_MAXIMO + 256 * 1024, { requestId });
  if (!lido.ok) return { ok: false, resposta: erro("corpo_grande", 413, requestId, "O envio passa do tamanho máximo aceito.") };
  const tipo = (req.headers.get("content-type") ?? "").toLowerCase();
  let bruto: unknown;
  const fotos: Uint8Array[] = [];
  if (tipo.startsWith("multipart/form-data")) {
    const form = await lido.corpo.formData().catch(() => null);
    if (!form) return ruim();
    const dados = form.get("dados");
    if (typeof dados !== "string") return ruim("No multipart, o JSON vai no campo 'dados'.");
    try {
      bruto = JSON.parse(dados);
    } catch {
      return ruim("O campo 'dados' não é JSON.");
    }
    for (const f of form.getAll("fotos")) {
      if (!(f instanceof File)) return ruim("Cada item de 'fotos' é um arquivo.");
      if (f.size > FOTO_BYTES_MAXIMO) return { ok: false, resposta: erro("foto_grande", 413, requestId, `Cada foto tem até ${FOTO_BYTES_MAXIMO / 1024} KB.`) };
      fotos.push(new Uint8Array(await f.arrayBuffer()));
    }
  } else {
    bruto = await lido.corpo.json().catch(() => undefined);
  }
  const p = corpoSchema.safeParse(bruto);
  if (!p.success) return ruim(p.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "acao"}: ${i.message}`).join("; "));
  if (fotos.length > 0 && p.data.acao !== "previa_cadastro") return ruim("Fotos só vão na previa_cadastro.");
  return { ok: true, corpo: p.data, fotos };
}

export async function POST(req: NextRequest) {
  // Mesma guarda de toda escrita do app: acompanhamento administrativo restrito só lê.
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "acervo",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  if (authz.via !== "token") return erro("so_token", 403, requestId);
  const teto = await tetoDeEscritaDoToken(authz, "acervo", requestId);
  if (teto) return teto;
  const { organizationId } = authz;
  const tokenId = authz.apiTokenId ?? null;
  if (!acervoLigado(organizationId)) return erro("acervo_desligado", 404, requestId);

  const lido = await lerCorpo(req, requestId);
  if (!lido.ok) return lido.resposta;
  const { corpo, fotos } = lido;
  const pool = getRequestPool();
  const auditar = (action: "acervo.previewed" | "acervo.recorded", metadata: Record<string, unknown>) =>
    void audit({ action, actorApiTokenId: tokenId, organizationId, resourceType: "organization", resourceId: organizationId, requestId, metadata });

  try {
    switch (corpo.acao) {
      case "gravar": {
        const r = await gravarPrevia(pool, organizationId, corpo.id_previa);
        if (!r.ok) return deFalha(r, requestId);
        if (!r.repetido) auditar("acervo.recorded", { acao: r.acao, id_previa: corpo.id_previa });
        return responder(r, 200, requestId);
      }
      case "disponibilidade": {
        const r = await disponibilidade(pool, organizationId, corpo.data_evento, corpo);
        return r.ok ? responder(r, 200, requestId) : deFalha(r, requestId);
      }
      case "consultar":
        return responder(await consultar(pool, organizationId, corpo), 200, requestId);
      default: {
        const r =
          corpo.acao === "previa_cadastro" ? await previaCadastro(pool, armazemDoStorage(requestId), organizationId, corpo, fotos, tokenId)
          : corpo.acao === "previa_publicar" ? await previaPublicar(pool, organizationId, corpo.codigo, corpo.publicar ?? true, tokenId)
          : corpo.acao === "previa_status" ? await previaStatus(pool, organizationId, corpo.codigo, corpo.status, corpo.motivo ?? null, tokenId)
          : corpo.acao === "previa_reserva" ? await previaReserva(pool, organizationId, corpo, tokenId)
          : await previaCancelarReserva(pool, organizationId, corpo.reserva_id, tokenId);
        if (!r.ok) return deFalha(r, requestId);
        auditar("acervo.previewed", { acao: corpo.acao, id_previa: r.id_previa });
        return responder(r, 200, requestId);
      }
    }
  } catch (e) {
    logger.error("[acervo] falhou", { requestId, organizationId, acao: corpo.acao, erro: e instanceof Error ? e.message : String(e) });
    return erro("falhou", 500, requestId);
  }
}
