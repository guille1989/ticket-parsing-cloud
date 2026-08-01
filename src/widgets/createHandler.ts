import { randomUUID } from "node:crypto";

import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveTenantIdFromEvent } from "../shared/auth.js";
import { ddb, WIDGETS_TABLE, widgetKey } from "../shared/dynamo.js";
import type { WidgetAggregation, WidgetFilters, WidgetRecord, WidgetVisualization } from "../shared/types.js";
import { AGGREGATIONS, CATEGORICAL_FIELDS, isTicketLevelField, isValidAggregation, isValidGroupByField, isValidMetricField } from "./fields.js";

const VISUALIZATIONS: WidgetVisualization[] = ["kpi", "bar", "donut"];
// Coincide con TicketStatus — no se reexporta desde acá para no acoplar
// este validador al tipo interno de otro módulo por algo tan chico.
const STATUSES = ["pending", "parsed", "needs_review", "failed"];
const MAX_NAME_LENGTH = 100;
const PORT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const MAX_PORT_LENGTH = 64;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?)?$/;

type WidgetInput = Omit<WidgetRecord, "tenantId" | "widgetId" | "createdAt">;
type Validation = { ok: true; value: WidgetInput } | { ok: false; error: string };

function validateBody(body: unknown): Validation {
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

  if (!b.metric || typeof b.metric !== "object") {
    return { ok: false, error: "metric inválido, se esperaba un objeto { field, aggregation }" };
  }
  const metricInput = b.metric as Record<string, unknown>;
  if (typeof metricInput.field !== "string" || !isValidMetricField(metricInput.field)) {
    return { ok: false, error: "metric.field inválido" };
  }
  if (typeof metricInput.aggregation !== "string" || !isValidAggregation(metricInput.aggregation)) {
    return { ok: false, error: `metric.aggregation inválida, se esperaba una de: ${AGGREGATIONS.join(", ")}` };
  }
  const metric = { field: metricInput.field, aggregation: metricInput.aggregation as WidgetAggregation };

  // KPI es un número solo, sin agrupar — bar/donut necesitan agrupar por
  // algo, si no no hay nada que dibujar.
  let groupBy: string | undefined;
  if (visualization === "kpi") {
    if (b.groupBy !== undefined) {
      return { ok: false, error: "un widget kpi no admite groupBy" };
    }
  } else {
    if (typeof b.groupBy !== "string" || !isValidGroupByField(b.groupBy)) {
      return { ok: false, error: `groupBy inválido, se esperaba uno de: ${CATEGORICAL_FIELDS.join(", ")}` };
    }
    // total/discount/tip son del ticket, no del ítem — no hay forma
    // correcta de repartirlos entre las descripciones de un mismo ticket.
    if (b.groupBy === "description" && isTicketLevelField(metric.field)) {
      return {
        ok: false,
        error: `no se puede agrupar "${metric.field}" (un valor por ticket) por "description" (un valor por ítem) — usá "subtotal" para desglosar por producto`,
      };
    }
    groupBy = b.groupBy;
  }

  let filters: WidgetFilters | undefined;
  if (b.filters !== undefined) {
    if (typeof b.filters !== "object" || b.filters === null) {
      return { ok: false, error: "filters inválido, se esperaba un objeto" };
    }
    const f = b.filters as Record<string, unknown>;
    filters = {};
    if (f.dateFrom !== undefined) {
      if (typeof f.dateFrom !== "string" || !ISO_DATE_PATTERN.test(f.dateFrom)) {
        return { ok: false, error: "filters.dateFrom inválido, se esperaba una fecha ISO-8601" };
      }
      filters.dateFrom = f.dateFrom;
    }
    if (f.dateTo !== undefined) {
      if (typeof f.dateTo !== "string" || !ISO_DATE_PATTERN.test(f.dateTo)) {
        return { ok: false, error: "filters.dateTo inválido, se esperaba una fecha ISO-8601" };
      }
      filters.dateTo = f.dateTo;
    }
    if (f.port !== undefined) {
      if (typeof f.port !== "string" || f.port.length === 0 || f.port.length > MAX_PORT_LENGTH || !PORT_PATTERN.test(f.port)) {
        return { ok: false, error: `filters.port inválido (máx ${MAX_PORT_LENGTH} caracteres; solo letras, números, "_", "." o "-")` };
      }
      filters.port = f.port;
    }
    if (f.status !== undefined) {
      if (typeof f.status !== "string" || !STATUSES.includes(f.status)) {
        return { ok: false, error: `filters.status inválido, se esperaba uno de: ${STATUSES.join(", ")}` };
      }
      filters.status = f.status;
    }
  }

  return { ok: true, value: { name: b.name.trim(), visualization, metric, groupBy, filters } };
}

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = resolveTenantIdFromEvent(event);
  if (!tenantId) {
    return { statusCode: 403, body: JSON.stringify({ error: "no autenticado" }) };
  }

  let body: unknown;
  try {
    body = event.body ? JSON.parse(event.body) : null;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "body inválido, se esperaba JSON" }) };
  }

  const validation = validateBody(body);
  if (!validation.ok) {
    return { statusCode: 400, body: JSON.stringify({ error: validation.error }) };
  }

  const widget: WidgetRecord = {
    tenantId,
    widgetId: randomUUID(),
    createdAt: new Date().toISOString(),
    ...validation.value,
  };

  await ddb.send(
    new PutCommand({
      TableName: WIDGETS_TABLE,
      Item: { ...widget, ...widgetKey(tenantId, widget.widgetId) },
    }),
  );

  return { statusCode: 201, body: JSON.stringify(widget) };
}
