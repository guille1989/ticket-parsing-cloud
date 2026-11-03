import { QueryCommand, ScanCommand, type QueryCommandOutput } from "@aws-sdk/lib-dynamodb";

import { AGENTS_TABLE, ddb, TENANTS_TABLE, TICKETS_TABLE } from "../shared/dynamo.js";
import { queryAllPages } from "../shared/pagination.js";
import type { AgentRecord, TenantRecord } from "../shared/types.js";

// Datos operativos de Advisor. Salen de DynamoDB y no de Athena a propósito: son baratos
// (decenas de ítems por tenant) y permiten correr los chequeos de "robot caído" y
// "captura en cero" cada hora sin tocar el layout de archivos chicos de S3.

export type AdvisorTenant = Pick<TenantRecord, "tenantId" | "businessName" | "advisor">;

/** Negocios activos y con registro completo: lo que Advisor revisa. */
export async function listAdvisorTenants(): Promise<AdvisorTenant[]> {
  const tenants: AdvisorTenant[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: TENANTS_TABLE,
        ProjectionExpression: "tenantId, businessName, #status, signupState, advisor",
        ExpressionAttributeNames: { "#status": "status" },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of (page.Items ?? []) as Array<AdvisorTenant & { status?: string; signupState?: string }>) {
      if (item.status === "blocked" || item.signupState === "provisioning") continue;
      tenants.push({ tenantId: item.tenantId, businessName: item.businessName, advisor: item.advisor });
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return tenants;
}

export async function loadAgents(tenantId: string): Promise<AgentRecord[]> {
  return queryAllPages<AgentRecord>({
    TableName: AGENTS_TABLE,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": "AGENT#" },
  });
}

export interface ReviewQueueSummary {
  count: number;
  /** capturedAt del ticket más viejo esperando revisión; ausente si la cola está vacía. */
  oldestCapturedAt?: string;
}

/**
 * Tickets `needs_review` que el dueño tendría que mirar, por el índice de estado (gsi1sk =
 * capturedAt, ascendente = el más viejo primero).
 *
 * No cuenta los leídos por visión (`parsedBy = bedrock-vision`): los POS que imprimen la factura
 * como imagen entran SIEMPRE a revisión por diseño, y en esos negocios la cola nunca se vacía
 * (Empanadas: 512 tickets, todos de visión). Cualquier umbral sobre ellos sería una alerta
 * permanente. Los que llegan por el fallback de texto sí son la excepción que vale la pena avisar.
 */
export async function loadReviewQueue(tenantId: string): Promise<ReviewQueueSummary> {
  const key = {
    TableName: TICKETS_TABLE,
    IndexName: "status-index",
    KeyConditionExpression: "gsi1pk = :gsi1pk",
    // Los tickets anteriores al campo `parsedBy` no lo tienen: cuentan como revisables.
    FilterExpression: "attribute_not_exists(parsedBy) OR parsedBy <> :vision",
    ExpressionAttributeValues: { ":gsi1pk": `TENANT#${tenantId}#STATUS#needs_review`, ":vision": "bedrock-vision" },
  };

  let count = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({ ...key, Select: "COUNT", ExclusiveStartKey: exclusiveStartKey }));
    count += page.Count ?? 0;
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  if (count === 0) return { count };

  // Sin `Limit`: DynamoDB lo aplica ANTES del filtro y podría devolver una página vacía aunque haya
  // coincidencias más adelante. Se recorren las páginas hasta encontrar el primero.
  let oldestCapturedAt: string | undefined;
  let nextKey: Record<string, unknown> | undefined;
  do {
    const page: QueryCommandOutput = await ddb.send(
      new QueryCommand({ ...key, ScanIndexForward: true, ProjectionExpression: "gsi1sk", ExclusiveStartKey: nextKey }),
    );
    oldestCapturedAt = (page.Items?.[0] as { gsi1sk?: string } | undefined)?.gsi1sk;
    nextKey = oldestCapturedAt ? undefined : page.LastEvaluatedKey;
  } while (nextKey);
  return { count, ...(oldestCapturedAt ? { oldestCapturedAt } : {}) };
}

export interface RecentTicket {
  agentId?: string;
  capturedAt: string;
  status: string;
}

/**
 * Tickets capturados desde `sinceIso` (ISO UTC). El SK de la tabla es `TICKET#<capturedAt>#<id>`,
 * así que alcanza con un rango sobre el SK: no hace falta Athena para saber si un robot sigue
 * capturando. Se piden solo los campos mínimos.
 */
export async function loadRecentTickets(tenantId: string, sinceIso: string): Promise<RecentTicket[]> {
  return queryAllPages<RecentTicket>({
    TableName: TICKETS_TABLE,
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :since AND :until",
    // "TICKET$" va justo después de "TICKET#": cota superior de todos los SK de ticket (excluye los DEDUP#).
    // Un solo BETWEEN: DynamoDB no admite dos condiciones sobre la misma clave de ordenamiento.
    ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":since": `TICKET#${sinceIso}`, ":until": "TICKET$" },
    ProjectionExpression: "agentId, capturedAt, #status",
    ExpressionAttributeNames: { "#status": "status" },
  });
}
