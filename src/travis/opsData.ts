import { QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import { AGENTS_TABLE, ddb, TENANTS_TABLE, TICKETS_TABLE } from "../shared/dynamo.js";
import { queryAllPages } from "../shared/pagination.js";
import type { AgentRecord, TenantRecord } from "../shared/types.js";

// Datos operativos de Travis. Salen de DynamoDB y no de Athena a propósito: son baratos
// (decenas de ítems por tenant) y permiten correr los chequeos de "robot caído" y
// "captura en cero" cada hora sin tocar el layout de archivos chicos de S3.

export type TravisTenant = Pick<TenantRecord, "tenantId" | "businessName" | "travis">;

/** Negocios activos y con registro completo: lo que Travis revisa. */
export async function listTravisTenants(): Promise<TravisTenant[]> {
  const tenants: TravisTenant[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: TENANTS_TABLE,
        ProjectionExpression: "tenantId, businessName, #status, signupState, travis",
        ExpressionAttributeNames: { "#status": "status" },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of (page.Items ?? []) as Array<TravisTenant & { status?: string; signupState?: string }>) {
      if (item.status === "blocked" || item.signupState === "provisioning") continue;
      tenants.push({ tenantId: item.tenantId, businessName: item.businessName, travis: item.travis });
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

/** Tickets `needs_review` del tenant, por el índice de estado (gsi1sk = capturedAt, ascendente = el más viejo primero). */
export async function loadReviewQueue(tenantId: string): Promise<ReviewQueueSummary> {
  const key = {
    TableName: TICKETS_TABLE,
    IndexName: "status-index",
    KeyConditionExpression: "gsi1pk = :gsi1pk",
    ExpressionAttributeValues: { ":gsi1pk": `TENANT#${tenantId}#STATUS#needs_review` },
  };

  let count = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({ ...key, Select: "COUNT", ExclusiveStartKey: exclusiveStartKey }));
    count += page.Count ?? 0;
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  if (count === 0) return { count };

  const oldest = await ddb.send(new QueryCommand({ ...key, ScanIndexForward: true, Limit: 1 }));
  const capturedAt = (oldest.Items?.[0] as { gsi1sk?: string } | undefined)?.gsi1sk;
  return { count, ...(capturedAt ? { oldestCapturedAt: capturedAt } : {}) };
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
