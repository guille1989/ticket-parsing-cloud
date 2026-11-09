import { QueryCommand } from "@aws-sdk/lib-dynamodb";

import { AGENTS_TABLE, ddb } from "../shared/dynamo.js";
import { getTenant } from "../shared/tenant.js";
import type { AgentRecord, TenantProfile } from "../shared/types.js";
import { isValidTimeZone } from "../widgets/fields.js";

/** Tope de nombres en el system prompt: alcanza para situar al modelo sin comer tokens de las reglas. */
const MAX_BRANCH_LABELS = 12;

const WEEKDAY_LABEL: Record<string, string> = {
  "1": "lun",
  "2": "mar",
  "3": "mié",
  "4": "jue",
  "5": "vie",
  "6": "sáb",
  "7": "dom",
};

export type AskBusinessContext = {
  businessName?: string;
  timeZone?: string;
  /** Nombres legibles de sucursales/robots, cortos, sin ids. */
  branchLabels: string[];
  /** Ficha P1 (currency / openingHours / industry), si el tenant la cargó. */
  profile?: TenantProfile;
};

/**
 * Ficha del negocio para el system prompt de Ask: nombre, zona, sucursales y
 * (P1) moneda/horarios/rubro. Nunca lanza: si falla la lectura, el prompt sigue.
 */
export async function loadAskBusinessContext(tenantId: string): Promise<AskBusinessContext> {
  let businessName: string | undefined;
  let timeZone: string | undefined;
  let profile: TenantProfile | undefined;
  try {
    const tenant = await getTenant(tenantId);
    const name = tenant?.businessName?.trim();
    if (name) businessName = name;
    const zone = tenant?.advisor?.timeZone;
    if (typeof zone === "string" && isValidTimeZone(zone)) timeZone = zone;
    if (tenant?.profile) profile = tenant.profile;
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

  return { businessName, timeZone, branchLabels, profile };
}

/** Resumen corto de horarios para el prompt (tope de tokens). */
export function formatOpeningHoursSummary(openingHours: TenantProfile["openingHours"]): string {
  if (!openingHours) return "(no cargados; no afirmes abierto/cerrado)";
  const parts: string[] = [];
  if (openingHours.default) {
    parts.push(`default ${openingHours.default.open}–${openingHours.default.close}`);
  }
  if (openingHours.byWeekday) {
    for (const day of ["1", "2", "3", "4", "5", "6", "7"] as const) {
      const value = openingHours.byWeekday[day];
      if (value === undefined) continue;
      const label = WEEKDAY_LABEL[day] ?? day;
      parts.push(value === "closed" ? `${label} cerrado` : `${label} ${value.open}–${value.close}`);
    }
  }
  return parts.length > 0 ? parts.join("; ") : "(no cargados; no afirmes abierto/cerrado)";
}

/**
 * Bloque de contexto inyectado en el system prompt. Moneda/horarios/rubro solo
 * si existen en la ficha; si no, deja explícito que no están cargados.
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

  const currency = ctx.profile?.currency?.trim();
  const locale = ctx.profile?.locale?.trim();
  const currencyLine = currency
    ? `- Moneda / locale: ${currency}${locale ? ` (${locale})` : ""} — usá esta moneda al nombrar montos`
    : "- Moneda: (no definida) — escribí solo números, sin símbolo";

  const industry = ctx.profile?.industry?.trim();
  const industryLine = industry ? `- Rubro: ${industry}` : undefined;

  const hoursLine = `- Horarios: ${formatOpeningHoursSummary(ctx.profile?.openingHours)}`;

  return [
    "Contexto del negocio (inyectado; no lo inventes ni lo completes):",
    `- Nombre: ${name}`,
    `- Zona: ${zoneLine}`,
    currencyLine,
    `- Sucursales (robots): ${branches}`,
    hoursLine,
    ...(industryLine ? [industryLine] : []),
  ].join("\n");
}
