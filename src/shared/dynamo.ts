import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const TICKETS_TABLE = process.env.TICKETS_TABLE ?? "";
export const TENANTS_TABLE = process.env.TENANTS_TABLE ?? "";
export const RAW_BUCKET = process.env.RAW_BUCKET ?? "";

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
