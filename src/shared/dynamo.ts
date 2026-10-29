import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const TICKETS_TABLE = process.env.TICKETS_TABLE ?? "";
export const TENANTS_TABLE = process.env.TENANTS_TABLE ?? "";
export const WIDGETS_TABLE = process.env.WIDGETS_TABLE ?? "";
export const AGENTS_TABLE = process.env.AGENTS_TABLE ?? "";
export const ACTIVATION_CODES_TABLE = process.env.ACTIVATION_CODES_TABLE ?? "";
export const REPORTS_TABLE = process.env.REPORTS_TABLE ?? "";
export const CONVERSATIONS_TABLE = process.env.CONVERSATIONS_TABLE ?? "";
export const ASSISTANT_USAGE_TABLE = process.env.ASSISTANT_USAGE_TABLE ?? "";
export const SIGNUP_USAGE_TABLE = process.env.SIGNUP_USAGE_TABLE ?? "";
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

/**
 * Marcador de deduplicación de contenido — mismo `pk` que los tickets del
 * tenant (`TENANT#<id>`) pero con un `sk` que empieza en "DEDUP#" en vez de
 * "TICKET#", así el Stream de la tabla dispara igual al parser (no hay
 * suscripción selectiva por prefijo de `sk`) pero `parser/handler.ts` lo
 * ignora de inmediato porque no tiene `status: "pending"`. Ver `ingest/handler.ts`.
 */
export function dedupKey(tenantId: string, contentHash: string) {
  return {
    pk: `TENANT#${tenantId}`,
    sk: `DEDUP#${contentHash}`,
  };
}

/** Clave de la tabla Tenants: PK = TENANT#<tenantId>. */
export function tenantKey(tenantId: string) {
  return { pk: `TENANT#${tenantId}` };
}

/** Clave de la tabla Reports: PK = TENANT#<tenantId>, SK = REPORT#<reportId> (reportId = ISO de creación + sufijo, ordena por fecha). */
export function reportKey(tenantId: string, reportId: string) {
  return {
    pk: `TENANT#${tenantId}`,
    sk: `REPORT#${reportId}`,
  };
}

/**
 * Clave de la tabla Conversations: PK = TENANT#<tenantId>, SK = CONV#<userId>#<conversationId>.
 * El userId (sub de Cognito) separa las conversaciones de cada persona del negocio; el
 * conversationId lleva el ISO de creación + sufijo, así que la última creada es la última por SK.
 */
export function conversationKey(tenantId: string, userId: string, conversationId: string) {
  return {
    pk: `TENANT#${tenantId}`,
    sk: `${conversationSkPrefix(userId)}${conversationId}`,
  };
}

export function conversationSkPrefix(userId: string) {
  return `CONV#${userId}#`;
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
 * Diagnóstico pedido por el operador a un agente — vive en la tabla Agents con
 * SK = CMD#<agentId>#<commandId>. El commandId empieza por el epoch en ms con
 * relleno (ordena por fecha) y no lleva "#", así sirve tal cual en un path.
 */
export function commandKey(tenantId: string, agentId: string, commandId: string) {
  return {
    pk: `TENANT#${tenantId}`,
    sk: `${commandSkPrefix(agentId)}${commandId}`,
  };
}

export function commandSkPrefix(agentId: string) {
  return `CMD#${agentId}#`;
}

/**
 * Clave de la tabla ActivationCodes: PK = CODE#<code>. Global (no anidada
 * bajo el tenant) porque quien canjea un código no sabe todavía a qué
 * tenant pertenece — eso lo resuelve el canje, no lo aporta el cliente.
 */
export function activationCodeKey(code: string) {
  return { pk: `CODE#${code}` };
}
