import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const TICKETS_TABLE = process.env.TICKETS_TABLE ?? "";
export const TENANTS_TABLE = process.env.TENANTS_TABLE ?? "";
export const WIDGETS_TABLE = process.env.WIDGETS_TABLE ?? "";
export const AGENTS_TABLE = process.env.AGENTS_TABLE ?? "";
export const ACTIVATION_CODES_TABLE = process.env.ACTIVATION_CODES_TABLE ?? "";
export const RAW_BUCKET = process.env.RAW_BUCKET ?? "";
export const ANALYTICS_BUCKET = process.env.ANALYTICS_BUCKET ?? "";
export const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP ?? "";

/**
 * Claves de la tabla Tickets (single-table design):
 *   PK = TENANT#<tenantId>
 *   SK = TICKET#<capturedAtIso>#<ticketId>      → orden cronológico por tenant
 *   GSI1PK = TENANT#<tenantId>#STATUS#<status>
 *   GSI1SK = <capturedAtIso>                     → cola de revisión por estado
 */
export function ticketKey(tenantId: string, capturedAt: string, ticketId: string) {
  return {
    pk: `TENANT#${tenantId}`,
    sk: `TICKET#${capturedAt}#${ticketId}`,
  };
}

export function ticketStatusGsiKey(tenantId: string, status: string, capturedAt: string) {
  return {
    gsi1pk: `TENANT#${tenantId}#STATUS#${status}`,
    gsi1sk: capturedAt,
  };
}

/** Clave de la tabla Tenants: PK = TENANT#<tenantId>. */
export function tenantKey(tenantId: string) {
  return { pk: `TENANT#${tenantId}` };
}

/** Clave de la tabla Widgets: PK = TENANT#<tenantId>, SK = WIDGET#<widgetId>. */
export function widgetKey(tenantId: string, widgetId: string) {
  return {
    pk: `TENANT#${tenantId}`,
    sk: `WIDGET#${widgetId}`,
  };
}

/** Clave de la tabla Agents: PK = TENANT#<tenantId>, SK = AGENT#<agentId>. */
export function agentKey(tenantId: string, agentId: string) {
  return {
    pk: `TENANT#${tenantId}`,
    sk: `AGENT#${agentId}`,
  };
}

/**
 * Clave de la tabla ActivationCodes: PK = CODE#<code>. Global (no anidada
 * bajo el tenant) porque quien canjea un código no sabe todavía a qué
 * tenant pertenece — eso lo resuelve el canje, no lo aporta el cliente.
 */
export function activationCodeKey(code: string) {
  return { pk: `CODE#${code}` };
}
