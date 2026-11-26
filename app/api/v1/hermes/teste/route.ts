/**
 * POST /api/v1/hermes/teste — o MODO TESTE do Hermes pelo CRM (fork elllo, teste1).
 *
 * Quem chama é o mensageiro do Hermes, por TOKEN (`dsk_…` com `mcp:write`); sessão de
 * navegador é recusada (403). A organização sai da linha do token, nunca do corpo. Só
 * responde na organização listada em `TESTE_DO_HERMES_ORGS` (vazia = 404, desligada).
 * O cabeçalho `Idempotency-Key` faz a mesma chamada repetida devolver o mesmo resultado
 * (abrir: o mesmo teste; turno: as respostas já gravadas, sem rodar o modelo de novo).
 *
 * Formato combinado com o mensageiro (sessão 2), fora do envelope `{data}` de propósito:
 *   - `{"acao":"abrir","persona"?,"canal_id"?}` → `{"ok":true,"id","contato_id","canal_id"}`
 *   - `{"acao":"turno","id","texto"}`            → `{"ok":true,"respostas":[…],"impedimentos":[{"codigo","motivo"}],
 *                                                   "propostas":[{"ferramenta","argumentos"}],"custo_usd","custo_centavos",
 *                                                   "versao_do_agente","repetido"}`
 *   - `{"acao":"fechar","id"}`                   → `{"ok":true,"sobra":{contatos,conversas,mensagens,notas,tracos,rascunhos},
 *                                                   "sobra_total","efeitos":{…},"efeitos_total"}`
 *   - `{"acao":"varrer","idade_minutos"?}`       → `{"ok":true,"fechados","sobra","efeitos"}` (o pente, padrão 120 min)
 *   - erro: `{"ok":false,"erro":"<código>"}` com HTTP 4xx/5xx.
 * `id` aceita também o nome `teste_id`.
 *
 * Nada é enviado a ninguém: o turno é a prévia assistida (`runAgentPreview`), em que as
 * ferramentas de escrita viram proposta. Toda a regra mora em `lib/teste-do-hermes/`.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { audit } from "@/lib/audit";
import { requestTurnDeps } from "@/lib/agent-engine/agent/request-deps";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { logger } from "@/lib/logger";
import {
  abrirTeste,
  fecharTeste,
  somaDosEfeitos,
  testeDoHermesLigado,
  turnoDoTeste,
  varrerTestes,
  TETO_DO_TEXTO,
} from "@/lib/teste-do-hermes/teste-do-hermes";

export const dynamic = "force-dynamic";

const idDoTeste = z.object({ id: z.uuid().optional(), teste_id: z.uuid().optional() });
const corpoSchema = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("abrir"), persona: z.string().max(200).optional(), canal_id: z.uuid().optional() }),
  idDoTeste.extend({ acao: z.literal("turno"), texto: z.string().trim().min(1).max(TETO_DO_TEXTO) }),
  idDoTeste.extend({ acao: z.literal("fechar") }),
  z.object({ acao: z.literal("varrer"), idade_minutos: z.number().int().min(10).max(1440).optional() }),
]);

function responder(corpo: Record<string, unknown>, status: number, requestId: string) {
  const res = NextResponse.json(corpo, { status });
  res.headers.set("X-Request-Id", requestId);
  return res;
}
const erro = (codigo: string, status: number, requestId: string) => responder({ ok: false, erro: codigo }, status, requestId);

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "teste_do_hermes",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  if (authz.via !== "token") return erro("so_token", 403, requestId);
  const teto = await tetoDeEscritaDoToken(authz, "teste_do_hermes", requestId);
  if (teto) return teto;
  const { organizationId } = authz;
  const actorApiTokenId = authz.apiTokenId ?? null;
  if (!testeDoHermesLigado(organizationId)) return erro("teste_desligado", 404, requestId);

  let corpo: z.infer<typeof corpoSchema>;
  try {
    corpo = corpoSchema.parse(await req.json());
  } catch {
    return erro("corpo_invalido", 400, requestId);
  }
  const chave = (req.headers.get("idempotency-key") ?? "").trim().slice(0, 200) || null;
  const testeId = "id" in corpo || "teste_id" in corpo ? (corpo.id ?? corpo.teste_id ?? null) : null;
  if ((corpo.acao === "turno" || corpo.acao === "fechar") && !testeId) return erro("sem_id", 400, requestId);

  const pool = getRequestPool();
  try {
    if (corpo.acao === "abrir") {
      const r = await abrirTeste(pool, organizationId, { persona: corpo.persona ?? null, canalId: corpo.canal_id ?? null, chave });
      if (!r.ok) return erro(r.codigo, 422, requestId);
      if (!r.repetido)
        void audit({ action: "teste_do_hermes.opened", actorApiTokenId, organizationId, resourceType: "conversation", resourceId: r.teste.testeId, requestId });
      return responder({ ok: true, id: r.teste.testeId, contato_id: r.teste.contatoId, canal_id: r.teste.canalId, repetido: r.repetido === true }, 200, requestId);
    }
    if (corpo.acao === "turno") {
      const r = await turnoDoTeste(pool, requestTurnDeps(), organizationId, testeId!, corpo.texto, chave);
      if (!r.ok) return erro(r.codigo, r.codigo === "teste_inexistente" ? 404 : 422, requestId);
      if (!r.turno.repetido)
        void audit({
          action: "teste_do_hermes.turn",
          actorApiTokenId,
          organizationId,
          resourceType: "conversation",
          resourceId: testeId,
          requestId,
          metadata: { respostas: r.turno.respostas.length, propostas: r.turno.propostas.map((p) => p.ferramenta), custo_cents: r.turno.custoCents },
        });
      return responder(
        {
          ok: true,
          respostas: r.turno.respostas,
          impedimentos: r.turno.impedimentos.map((i) => ({ codigo: i.code, motivo: i.message.slice(0, 300) })),
          propostas: r.turno.propostas,
          custo_usd: Math.round(r.turno.custoCents) / 100,
          custo_centavos: r.turno.custoCents,
          versao_do_agente: r.turno.versaoDoAgente,
          repetido: r.turno.repetido === true,
        },
        200,
        requestId,
      );
    }
    if (corpo.acao === "fechar") {
      const r = await fecharTeste(pool, organizationId, testeId!);
      if (!r.ok) return erro(r.codigo, 404, requestId);
      const total = somaDosEfeitos(r.efeitos);
      if (total > 0 || r.sobra > 0)
        logger.error("[teste-do-hermes] o teste deixou efeito ou sobra", { organizationId, testeId, efeitos: r.efeitos, sobra: r.sobraDetalhe });
      void audit({
        action: "teste_do_hermes.closed",
        actorApiTokenId,
        organizationId,
        resourceType: "conversation",
        resourceId: testeId,
        requestId,
        metadata: { efeitos_total: total, sobra: r.sobra },
      });
      return responder({ ok: true, sobra: r.sobraDetalhe, sobra_total: r.sobra, efeitos: r.efeitos, efeitos_total: total }, 200, requestId);
    }
    const r = await varrerTestes(pool, organizationId, corpo.idade_minutos);
    if (r.fechados > 0)
      void audit({ action: "teste_do_hermes.swept", actorApiTokenId, organizationId, resourceType: "organization", resourceId: organizationId, requestId, metadata: r });
    return responder({ ok: true, ...r }, 200, requestId);
  } catch (e) {
    logger.error("[teste-do-hermes] falhou", { requestId, organizationId, acao: corpo.acao, erro: e instanceof Error ? e.message : String(e) });
    return erro("falhou", 500, requestId);
  }
}
