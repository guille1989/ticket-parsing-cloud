import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveActiveTenantIdFromEvent } from "../shared/auth.js";
import { jsonResponse } from "../shared/http.js";
import { addDays } from "./detectors/stats.js";
import { loadBranchLabels, toPublicMatter } from "./matterApi.js";
import { listMatters } from "./matterStore.js";
import type { MatterSeverity, MatterStatus } from "./types.js";

const DEFAULT_DAYS = 14;
const MAX_DAYS = 90; // = retención de los asuntos
const STATUSES: readonly MatterStatus[] = ["new", "seen", "dismissed", "resolved"];
const SEVERITY_RANK: Record<MatterSeverity, number> = { info: 0, warn: 1, critical: 2 };

function parseDays(raw: string | undefined): number {
  const parsed = raw ? Number(raw) : DEFAULT_DAYS;
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, MAX_DAYS) : DEFAULT_DAYS;
}

/**
 * Los asuntos de Travis del negocio, del día más reciente al más viejo y, dentro de cada día,
 * lo más grave primero. `?days=14` (hasta 90) acota el rango y `?status=new,seen` filtra por
 * estado. `newCount` cuenta los que el dueño todavía no vio, sin importar el filtro: es el
 * número de la campana.
 */
export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = await resolveActiveTenantIdFromEvent(event);
  if (!tenantId) {
    return jsonResponse(403, { error: "no autenticado" });
  }

  const params = event.queryStringParameters ?? {};
  let statuses: MatterStatus[] | undefined;
  if (params.status) {
    statuses = params.status.split(",").map((status) => status.trim()) as MatterStatus[];
    const invalid = statuses.find((status) => !STATUSES.includes(status));
    if (invalid) return jsonResponse(400, { error: `status inválido "${invalid}", se esperaba: ${STATUSES.join(", ")}` });
  }

  const today = new Date().toISOString().slice(0, 10);
  const items = await listMatters(tenantId, addDays(today, -parseDays(params.days)));
  const visible = items
    .filter((item) => !statuses || statuses.includes(item.status))
    // La lista ya viene por fecha descendente; dentro del mismo día, lo más grave primero (sort estable).
    .sort((a, b) => (a.periodDate === b.periodDate ? SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] : 0));

  // Las sucursales solo se nombran si algún asunto las menciona: evita una consulta que casi siempre sobra.
  const labels = visible.some((item) => item.scope.startsWith("branch:")) ? await loadBranchLabels(tenantId) : new Map<string, string>();

  return jsonResponse(200, {
    matters: visible.map((item) => toPublicMatter(item, labels)),
    newCount: items.filter((item) => item.status === "new").length,
  });
}
