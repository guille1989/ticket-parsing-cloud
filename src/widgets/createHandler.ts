import { randomUUID } from "node:crypto";

import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { PAYMENT_METHODS, resolvePaymentMethodFilter } from "../parsing/bedrockShared.js";
import { resolveActiveTenantFromEvent, resolveUserIdFromEvent } from "../shared/auth.js";
import { ddb, WIDGETS_TABLE, widgetKey } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import { userViewFor } from "../shared/userView.js";
import type { WidgetAggregation, WidgetFilters, WidgetMetric, WidgetRecord, WidgetVisualization } from "../shared/types.js";
import { AGGREGATIONS, CATEGORICAL_FIELDS, TEMPORAL_FIELDS, isItemLevelGroupBy, isTicketLevelField, isValidAggregation, isValidGroupByField, isValidMetricField } from "./fields.js";
import { dateFilterError } from "./dateFilters.js";

const VISUALIZATIONS: WidgetVisualization[] = ["kpi", "bar", "line", "donut"];
// Coincide con TicketStatus — no se reexporta desde acá para no acoplar
// este validador al tipo interno de otro módulo por algo tan chico.
const STATUSES = ["pending", "parsed", "needs_review", "failed"];
const MAX_NAME_LENGTH = 100;
const PORT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const MAX_PORT_LENGTH = 64;
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_AGENT_ID_LENGTH = 64;
// Igual que MAX_DESCRIPTION_FILTER_LENGTH en assistant/askHandler.ts.
const MAX_DESCRIPTION_LENGTH = 50;

type WidgetInput = Omit<WidgetRecord, "tenantId" | "widgetId" | "createdAt">;
type Validation = { ok: true; value: WidgetInput } | { ok: false; error: string };

export function validateBody(body: unknown): Validation {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "se esperaba un objeto JSON" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.name !== "string" || b.name.trim().length === 0 || b.name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `name inválido (no vacío, máx ${MAX_NAME_LENGTH} caracteres)` };
  }
  if (typeof b.visualization !== "string" || !VISUALIZATIONS.includes(b.visualization as WidgetVisualization)) {
    return { ok: false, error: `visualization inválida, se esperaba una de: ${VISUALIZATIONS.join(", ")}` };
  }
  const visualization = b.visualization as WidgetVisualization;

  const parsedMetric = parseMetric(b.metric, "metric");
  if ("error" in parsedMetric) return { ok: false, error: parsedMetric.error };
  const metric = parsedMetric;

  let secondaryMetric: WidgetMetric | undefined;
  if (b.secondaryMetric !== undefined) {
    if (visualization !== "kpi") {
      return { ok: false, error: "secondaryMetric solo está disponible para widgets kpi" };
    }
    const parsedSecondary = parseMetric(b.secondaryMetric, "secondaryMetric");
    if ("error" in parsedSecondary) return { ok: false, error: parsedSecondary.error };
    secondaryMetric = parsedSecondary;
  }

  // KPI es un número solo, sin agrupar — bar/donut necesitan agrupar por
  // algo, si no no hay nada que dibujar.
  let groupBy: string | undefined;
  if (visualization === "kpi") {
    if (b.groupBy !== undefined) {
      return { ok: false, error: "un widget kpi no admite groupBy" };
    }
  } else {
    if (typeof b.groupBy !== "string" || !isValidGroupByField(b.groupBy)) {
      return { ok: false, error: `groupBy inválido, se esperaba uno de: ${[...CATEGORICAL_FIELDS, ...TEMPORAL_FIELDS].join(", ")}` };
    }
    if (visualization === "line" && !TEMPORAL_FIELDS.includes(b.groupBy as never)) {
      return { ok: false, error: `un widget line necesita groupBy temporal: ${TEMPORAL_FIELDS.join(", ")}` };
    }
    if (visualization !== "line" && TEMPORAL_FIELDS.includes(b.groupBy as never)) {
      return { ok: false, error: "groupBy temporal solo está disponible para widgets line" };
    }
    // total/discount/tip son del ticket, no del ítem — no hay forma
    // correcta de repartirlos entre las descripciones de un mismo ticket.
    if (isItemLevelGroupBy(b.groupBy as string) && isTicketLevelField(metric.field)) {
      return {
        ok: false,
        error: `no se puede agrupar "${metric.field}" (un valor por ticket) por "${b.groupBy}" (un valor por ítem) — usá "subtotal" para desglosar por producto`,
      };
    }
    groupBy = b.groupBy;
  }

  let filters: WidgetFilters | undefined;
  if (b.filters !== undefined) {
    if (typeof b.filters !== "object" || b.filters === null || Array.isArray(b.filters)) {
      return { ok: false, error: "filters inválido, se esperaba un objeto" };
    }
    const f = b.filters as Record<string, unknown>;
    filters = {};
    const dateError = dateFilterError(f);
    if (dateError) return { ok: false, error: `filters.${dateError}` };
    if (f.dateFrom !== undefined) {
      filters.dateFrom = f.dateFrom as string;
    }
    if (f.dateTo !== undefined) {
      filters.dateTo = f.dateTo as string;
    }
    if (f.port !== undefined) {
      if (typeof f.port !== "string" || f.port.length === 0 || f.port.length > MAX_PORT_LENGTH || !PORT_PATTERN.test(f.port)) {
        return { ok: false, error: `filters.port inválido (máx ${MAX_PORT_LENGTH} caracteres; solo letras, números, "_", "." o "-")` };
      }
      filters.port = f.port;
    }
    if (f.agentId !== undefined) {
      if (typeof f.agentId !== "string" || f.agentId.length === 0 || f.agentId.length > MAX_AGENT_ID_LENGTH || !AGENT_ID_PATTERN.test(f.agentId)) {
        return { ok: false, error: `filters.agentId inválido (máx ${MAX_AGENT_ID_LENGTH} caracteres; solo letras, números, "_" o "-")` };
      }
      filters.agentId = f.agentId;
    }
    if (f.status !== undefined) {
      if (typeof f.status !== "string" || !STATUSES.includes(f.status)) {
        return { ok: false, error: `filters.status inválido, se esperaba uno de: ${STATUSES.join(", ")}` };
      }
      filters.status = f.status;
    }
    if (f.paymentMethod !== undefined) {
      const method = resolvePaymentMethodFilter(f.paymentMethod);
      if (!method) {
        return { ok: false, error: `filters.paymentMethod inválido, se esperaba uno de: ${PAYMENT_METHODS.join(", ")}` };
      }
      filters.paymentMethod = method;
    }
    if (f.descriptionContains !== undefined) {
      if (typeof f.descriptionContains !== "string" || f.descriptionContains.trim().length === 0 || f.descriptionContains.length > MAX_DESCRIPTION_LENGTH) {
        return { ok: false, error: `filters.descriptionContains inválido (texto no vacío, máx ${MAX_DESCRIPTION_LENGTH} caracteres)` };
      }
      for (const m of [metric, secondaryMetric]) {
        if (m && isTicketLevelField(m.field)) {
          return { ok: false, error: `no se puede filtrar "${m.field}" (un valor por ticket) por descripción de producto — usá "subtotal" o "quantity"` };
        }
      }
      filters.descriptionContains = f.descriptionContains.trim();
    }
  }

  return { ok: true, value: { name: b.name.trim(), visualization, metric, ...(secondaryMetric ? { secondaryMetric } : {}), groupBy, filters } };
}

function parseMetric(input: unknown, label: string): WidgetMetric | { error: string } {
  if (!input || typeof input !== "object") {
    return { error: `${label} inválido, se esperaba un objeto { field, aggregation }` };
  }
  const m = input as Record<string, unknown>;
  if (typeof m.field !== "string" || !isValidMetricField(m.field)) {
    return { error: `${label}.field inválido` };
  }
  if (typeof m.aggregation !== "string" || !isValidAggregation(m.aggregation)) {
    return { error: `${label}.aggregation inválida, se esperaba una de: ${AGGREGATIONS.join(", ")}` };
  }
  return { field: m.field, aggregation: m.aggregation as WidgetAggregation };
}

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenant = await resolveActiveTenantFromEvent(event);
  if (!tenant) {
    return jsonResponse(403, { error: "no autenticado" });
  }
  const tenantId = tenant.tenantId;
  const userId = resolveUserIdFromEvent(event);
  const ownView = userViewFor(tenant, userId) !== undefined;

  let body: unknown;
  try {
    body = event.body ? JSON.parse(event.body) : null;
  } catch {
    return jsonResponse(400, { error: "body inválido, se esperaba JSON" });
  }

  const validation = validateBody(body);
  if (!validation.ok) {
    return jsonResponse(400, { error: validation.error });
  }

  const widget: WidgetRecord = {
    tenantId,
    widgetId: randomUUID(),
    createdAt: new Date().toISOString(),
    ...validation.value,
    ...(ownView && userId ? { userId } : {}),
  };

  await ddb.send(
    new PutCommand({
      TableName: WIDGETS_TABLE,
      Item: { ...widget, ...widgetKey(tenantId, widget.widgetId) },
    }),
  );

  return jsonResponse(201, widget);
}
