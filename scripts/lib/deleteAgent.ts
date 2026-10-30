// Lógica de `scripts/delete-agent.ts`: borrar UN agente de un negocio (su
// api-key de API Gateway, su registro y los diagnósticos que tuviera), sin
// tocar el negocio, sus tickets ni sus códigos de activación. Se separa del
// script para poder probarla con clientes falsos.
import { DeleteApiKeyCommand, type APIGatewayClient } from "@aws-sdk/client-api-gateway";
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
  type QueryCommandOutput,
} from "@aws-sdk/lib-dynamodb";

import { agentKey, commandSkPrefix } from "../../src/shared/dynamo.js";
import type { AgentRecord } from "../../src/shared/types.js";

/** Un agente visto hace menos que esto sigue conectado: borrarlo lo dejaría sin credenciales en caliente. */
export const LIVE_WINDOW_MS = 15 * 60 * 1000;

export interface DeleteAgentDeps {
  ddb: DynamoDBDocumentClient;
  apigw: APIGatewayClient;
  agentsTable: string;
  /** Opcional: solo sirve para contar los tickets que dejó el agente (informativo). */
  ticketsTable?: string;
}

export interface AgentDeletionPlan {
  tenantId: string;
  agentId: string;
  name: string;
  version?: string;
  lastSeenAt?: string;
  apiKeyId?: string;
  /** Diagnósticos guardados del agente (`CMD#<agentId>#…`). */
  commandKeys: Array<{ pk: string; sk: string }>;
  /** Tickets que subió este agente; NO se borran. `undefined` si no se pudo contar. */
  ticketCount?: number;
  /** Visto dentro de `LIVE_WINDOW_MS`. */
  live: boolean;
}

export async function planAgentDeletion(
  deps: DeleteAgentDeps,
  tenantId: string,
  agentId: string,
  now: Date = new Date(),
): Promise<AgentDeletionPlan> {
  const found = await deps.ddb.send(
    new GetCommand({ TableName: deps.agentsTable, Key: agentKey(tenantId, agentId), ConsistentRead: true }),
  );
  const agent = found.Item as AgentRecord | undefined;
  if (!agent) throw new Error(`el agente ${agentId} no existe en el negocio ${tenantId}`);

  const commandKeys: Array<{ pk: string; sk: string }> = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await deps.ddb.send(
      new QueryCommand({
        TableName: deps.agentsTable,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": commandSkPrefix(agentId) },
        ProjectionExpression: "pk, sk",
        ExclusiveStartKey: startKey,
      }),
    );
    commandKeys.push(...((page.Items ?? []) as Array<{ pk: string; sk: string }>));
    startKey = page.LastEvaluatedKey;
  } while (startKey);

  let ticketCount: number | undefined;
  if (deps.ticketsTable) {
    ticketCount = 0;
    let ticketStartKey: Record<string, unknown> | undefined;
    do {
      const page: QueryCommandOutput = await deps.ddb.send(
        new QueryCommand({
          TableName: deps.ticketsTable,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          FilterExpression: "agentId = :agent",
          ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": "TICKET#", ":agent": agentId },
          Select: "COUNT",
          ExclusiveStartKey: ticketStartKey,
        }),
      );
      ticketCount += page.Count ?? 0;
      ticketStartKey = page.LastEvaluatedKey;
    } while (ticketStartKey);
  }

  return {
    tenantId,
    agentId,
    name: agent.name,
    version: agent.version,
    lastSeenAt: agent.lastSeenAt,
    apiKeyId: agent.apiKeyId,
    commandKeys,
    ticketCount,
    live: !!agent.lastSeenAt && now.getTime() - Date.parse(agent.lastSeenAt) <= LIVE_WINDOW_MS,
  };
}

/**
 * Orden pensado para no dejar huérfanos: primero la api-key (si falla por algo
 * que no sea "ya no existe", se aborta con el registro intacto y se puede
 * reintentar), después los diagnósticos y por último el registro del agente.
 */
export async function executeAgentDeletion(deps: DeleteAgentDeps, plan: AgentDeletionPlan): Promise<void> {
  if (plan.apiKeyId) {
    try {
      await deps.apigw.send(new DeleteApiKeyCommand({ apiKey: plan.apiKeyId }));
    } catch (err) {
      if ((err as { name?: string }).name !== "NotFoundException") throw err;
    }
  }

  for (let i = 0; i < plan.commandKeys.length; i += 25) {
    await deps.ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [deps.agentsTable]: plan.commandKeys.slice(i, i + 25).map((key) => ({ DeleteRequest: { Key: key } })),
        },
      }),
    );
  }

  await deps.ddb.send(new DeleteCommand({ TableName: deps.agentsTable, Key: agentKey(plan.tenantId, plan.agentId) }));
}
