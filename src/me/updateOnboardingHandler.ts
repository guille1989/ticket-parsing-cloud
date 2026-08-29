import { randomUUID } from "node:crypto";

import { QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveTenantIdFromEvent } from "../shared/auth.js";
import { AGENTS_TABLE, ddb, TENANTS_TABLE, tenantKey, widgetKey, WIDGETS_TABLE } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import { getTenant } from "../shared/tenant.js";
import type { AgentRecord, OnboardingState, WidgetRecord } from "../shared/types.js";

type Action = "start" | "defer" | "complete" | "complete-product-tour" | "create-starter-dashboard";
const ACTIONS: Action[] = ["start", "defer", "complete", "complete-product-tour", "create-starter-dashboard"];

function starterWidgets(tenantId: string, createdAt: string): WidgetRecord[] {
  return [
    { tenantId, widgetId: randomUUID(), createdAt, name: "Tickets procesados", visualization: "kpi", metric: { field: "event_count", aggregation: "count" } },
    { tenantId, widgetId: randomUUID(), createdAt, name: "Ventas totales", visualization: "kpi", metric: { field: "total", aggregation: "sum" } },
    { tenantId, widgetId: randomUUID(), createdAt, name: "Evolución de ventas", visualization: "line", metric: { field: "total", aggregation: "sum" }, groupBy: "day" },
  ];
}

async function hasActivatedAgent(tenantId: string): Promise<boolean> {
  const result = await ddb.send(new QueryCommand({
    TableName: AGENTS_TABLE,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": "AGENT#" },
  }));
  return ((result.Items as AgentRecord[] | undefined) ?? []).length > 0;
}

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = resolveTenantIdFromEvent(event);
  if (!tenantId) return jsonResponse(403, { error: "no autenticado" });

  let body: unknown;
  try {
    body = event.body ? JSON.parse(event.body) : null;
  } catch {
    return jsonResponse(400, { error: "body inválido, se esperaba JSON" });
  }
  const action = body && typeof body === "object" ? (body as Record<string, unknown>).action : undefined;
  if (typeof action !== "string" || !ACTIONS.includes(action as Action)) {
    return jsonResponse(400, { error: `action inválida, se esperaba una de: ${ACTIONS.join(", ")}` });
  }

  const tenant = await getTenant(tenantId);
  if (!tenant) return jsonResponse(404, { error: "negocio no encontrado" });

  const now = new Date().toISOString();
  const current: OnboardingState = tenant.onboarding ?? { version: 1 };
  let next: OnboardingState = { ...current };

  if (action === "complete" && !(await hasActivatedAgent(tenantId))) {
    return jsonResponse(409, { error: "activá al menos un agente antes de finalizar la configuración" });
  }

  if (action === "start") next.startedAt ??= now;
  if (action === "defer") next = { ...next, startedAt: next.startedAt ?? now, lastDeferredAt: now };
  if (action === "complete") next = { ...next, startedAt: next.startedAt ?? now, completedAt: next.completedAt ?? now };
  if (action === "complete-product-tour") next = { ...next, productTourCompletedAt: next.productTourCompletedAt ?? now };

  if (action === "create-starter-dashboard") {
    if (next.starterDashboardCreatedAt) return jsonResponse(200, { onboarding: next });
    next = { ...next, startedAt: next.startedAt ?? now, starterDashboardCreatedAt: now };
    const widgets = starterWidgets(tenantId, now);
    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TENANTS_TABLE,
              Key: tenantKey(tenantId),
              UpdateExpression: "SET onboarding = :onboarding",
              ConditionExpression: "attribute_not_exists(onboarding.starterDashboardCreatedAt)",
              ExpressionAttributeValues: { ":onboarding": next },
            },
          },
          ...widgets.map((widget) => ({
            Put: { TableName: WIDGETS_TABLE, Item: { ...widget, ...widgetKey(tenantId, widget.widgetId) } },
          })),
        ],
      }));
    } catch (err) {
      // Una petición simultánea pudo ganar la condición. Volvemos a leer y
      // respondemos de forma idempotente si el dashboard ya quedó creado.
      const latest = await getTenant(tenantId);
      if (latest?.onboarding?.starterDashboardCreatedAt) {
        return jsonResponse(200, { onboarding: latest.onboarding });
      }
      throw err;
    }
    return jsonResponse(200, { onboarding: next });
  }

  await ddb.send(new UpdateCommand({
    TableName: TENANTS_TABLE,
    Key: tenantKey(tenantId),
    UpdateExpression: "SET onboarding = :onboarding",
    ExpressionAttributeValues: { ":onboarding": next },
  }));
  return jsonResponse(200, { onboarding: next });
}
