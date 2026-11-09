import { QueryCommand } from "@aws-sdk/lib-dynamodb";

import { AGENTS_TABLE, ddb } from "../shared/dynamo.js";
import { getTenant } from "../shared/tenant.js";
import type { AgentRecord } from "../shared/types.js";
import { isValidTimeZone } from "../widgets/fields.js";

/** Tope de nombres en el system prompt: alcanza para situar al modelo sin comer tokens de las reglas. */
const MAX_BRANCH_LABELS = 12;

export type AskBusinessContext = {
  businessName?: string;
  timeZone?: string;
  /** Nombres legibles de sucursales/robots, cortos, sin ids. */
  branchLabels: string[];
};

/**
 * Ficha mínima del negocio para el system prompt de Ask (P0): nombre, zona y
 * lista corta de sucursales. No inventa moneda ni horarios (eso es P1).
 * Nunca lanza: si falla la lectura, el prompt sigue sin ficha.
 */
export async function loadAskBusinessContext(tenantId: string): Promise<AskBusinessContext> {
  let businessName: string | undefined;
  let timeZone: string | undefined;
  try {
    const tenant = await getTenant(tenantId);
    const name = tenant?.businessName?.trim();
    if (name) businessName = name;
    const zone = tenant?.advisor?.timeZone;
    if (typeof zone === "string" && isValidTimeZone(zone)) timeZone = zone;
  } catch (err) {
    console.error(`[assistant] no se pudo leer el tenant ${tenantId}:`, err);
  }

  const branchLabels: string[] = [];
  try {
    const result = await ddb.send(
      new QueryCommand({
        TableName: AGENTS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": "AGENT#" },
      }),
    );
    const agents = ((result.Items as Array<Partial<AgentRecord>> | undefined) ?? []).filter(
      (agent): agent is AgentRecord => typeof agent.agentId === "string" && typeof agent.name === "string",
    );
    const labelOf = (agent: AgentRecord) => agent.location?.label?.trim() || agent.name;
    const labelCount = new Map<string, number>();
    for (const agent of agents) labelCount.set(labelOf(agent), (labelCount.get(labelOf(agent)) ?? 0) + 1);
    for (const agent of agents) {
      const label = labelOf(agent);
      const display = (labelCount.get(label) ?? 0) > 1 && label !== agent.name ? `${label} (${agent.name})` : label;
      if (!branchLabels.includes(display)) branchLabels.push(display);
      if (branchLabels.length >= MAX_BRANCH_LABELS) break;
    }
  } catch (err) {
    console.error(`[assistant] no se pudieron leer las sucursales del tenant ${tenantId}:`, err);
  }

  return { businessName, timeZone, branchLabels };
}

/**
 * Bloque de contexto inyectado en el system prompt. Sin inventar moneda ni
 * horarios: P0 solo nombra lo que ya existe en el tenant.
 */
export function formatBusinessContextBlock(
  ctx: AskBusinessContext,
  localDate: string,
  zoneOwner: "business" | "user" | "utc",
  timeZone?: string,
): string {
  const name = ctx.businessName ?? "(sin nombre)";
  const zoneLine =
    timeZone && zoneOwner === "business"
      ? `${timeZone} | Hoy: ${localDate}`
      : timeZone && zoneOwner === "user"
        ? `navegador ${timeZone} | Hoy: ${localDate}`
        : `UTC | Hoy: ${localDate}`;
  const branches =
    ctx.branchLabels.length > 0 ? ctx.branchLabels.join(", ") : "aún sin agentes activados";
  return [
    "Contexto del negocio (inyectado; no lo inventes ni lo completes):",
    `- Nombre: ${name}`,
    `- Zona: ${zoneLine}`,
    "- Moneda: (no definida) — escribí solo números, sin símbolo",
    `- Sucursales (robots): ${branches}`,
    "- Horarios: (no cargados; no afirmes abierto/cerrado)",
  ].join("\n");
}
