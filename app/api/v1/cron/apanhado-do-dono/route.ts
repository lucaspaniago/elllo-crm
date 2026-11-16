/**
 * O APANHADO DAS 7H AO DONO (fork elllo, 16/11/2026, migration 9004).
 *
 * ═══ POR QUE DE DEZ EM DEZ MINUTOS ═══
 *
 * A mesma razão do resumo da agenda (`../agenda-resumo-do-dia`): "7h" é o
 * relógio de parede de cada organização, e a janela vai até 10h para o dia em
 * que o número está parado às 7h. `aplicaApanhado` só age dentro dela, e a
 * reivindicação dos itens (`incluido_em`) garante que cada um sai UMA vez.
 *
 * ═══ OS GRUPOS, UMA VEZ POR HORA ═══
 *
 * Na rodada dos primeiros dez minutos de cada hora, o número que nunca teve
 * grupo na fila ganha todos os grupos que o WhatsApp devolver
 * (`ligarGruposSeNenhum`, `lib/escalacao/grupos-pelo-jev.ts`). Uma linha na
 * fila — ligada ou desligada pela tela — basta para isto não mexer mais.
 *
 * ═══ AUDITORIA ═══
 *
 * Nenhuma linha por rodada (a batida das 3h que não tinha o que fazer não é
 * mutação). O envio fica no log, e o grupo ligado é auditado por
 * `alternarGrupo` (`channel.group_enabled`).
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { aplicaApanhado, criarDepsDoApanhado, expurgarItensVelhos } from "@/lib/escalacao/apanhado-do-dono";
import { ligarGruposSeNenhum } from "@/lib/escalacao/grupos-pelo-jev";
import { lerJevDoFork, settingsDaOrganizacao } from "@/lib/escalacao/jev-do-fork";
import { logger } from "@/lib/logger";
import { idsDeOrgsParadas } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Quantas organizações uma rodada atende. O resto fica para a de daqui a 10 min. */
const TETO_DE_ORGANIZACOES = 200;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  // Quem recebe a nota de tom áspero recebe o apanhado: a mesma configuração.
  const { data, error } = await admin
    .from("config_aviso_de_caso")
    .select("organization_id")
    .eq("ligado", true)
    .eq("aviso_de_passagem_ligado", true)
    .limit(TETO_DE_ORGANIZACOES);
  if (error) {
    logger.error("[apanhado-do-dono] configurações não lidas", { error: error.message, requestId });
    return fail("internal_error", "Falha ao buscar configurações.", 500, { requestId });
  }
  const ligadas = ((data ?? []) as Array<{ organization_id: string }>).map((l) => l.organization_id);
  if (ligadas.length === 0) return ok({ organizacoes: 0, enviados: 0, desfechos: {} }, { requestId });

  // Organização parada (suspensa, redigida, arquivada) não gasta nem fala.
  const paradas = new Set(await idsDeOrgsParadas(admin));
  const deps = await criarDepsDoApanhado(admin);
  const primeiraRodadaDaHora = new Date().getUTCMinutes() < 10;

  let enviados = 0;
  const desfechos: Record<string, number> = {};
  const contar = (chave: string) => {
    desfechos[chave] = (desfechos[chave] ?? 0) + 1;
  };

  for (const orgId of ligadas) {
    if (paradas.has(orgId)) {
      contar("organizacao_parada");
      continue;
    }
    try {
      const desfecho = await aplicaApanhado(deps, orgId);
      if (desfecho.status === "ok") enviados += 1;
      contar(`${desfecho.status}:${desfecho.detail.split(":").slice(0, 2).join(":")}`);
      if (primeiraRodadaDaHora) {
        if (lerJevDoFork(await settingsDaOrganizacao(admin, orgId)).grupos) {
          const ligados = await ligarGruposSeNenhum(admin, orgId);
          if (ligados > 0) contar("grupos_ligados");
        }
        await expurgarItensVelhos(admin, orgId);
      }
    } catch (err) {
      // Uma organização com defeito não pode derrubar o apanhado das outras.
      contar("erro");
      logger.error("[apanhado-do-dono] rodada falhou", {
        organization_id: orgId,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
    }
  }

  return ok({ organizacoes: ligadas.length, enviados, desfechos }, { requestId });
}

export const GET = handle;
export const POST = handle;
