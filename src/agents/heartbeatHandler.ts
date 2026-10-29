import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { resolveAgentByApiKeyId } from "../shared/agent.js";
import { agentKey, AGENTS_TABLE, commandKey, commandSkPrefix, ddb } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import type { AgentCommandRecord } from "../shared/types.js";
import { COMMAND_MAX_AGE_MS } from "./commandCatalog.js";

interface HeartbeatBody {
  name?: string;
  version?: string;
  location?: { label?: string; city?: string; lat?: number; lng?: number };
}

function parseBody(raw: string | null): HeartbeatBody | undefined {
  try {
    const body = JSON.parse(raw ?? "{}") as HeartbeatBody;
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100)) return undefined;
    if (body.version !== undefined && (typeof body.version !== "string" || body.version.length > 40)) return undefined;
    if (body.location !== undefined) {
      const l = body.location;
      if (!l || typeof l !== "object" || Array.isArray(l)) return undefined;
      if (l.label !== undefined && (typeof l.label !== "string" || l.label.length > 120)) return undefined;
      if (l.city !== undefined && (typeof l.city !== "string" || l.city.length > 120)) return undefined;
      if (l.lat !== undefined && (typeof l.lat !== "number" || !Number.isFinite(l.lat) || l.lat < -90 || l.lat > 90)) return undefined;
      if (l.lng !== undefined && (typeof l.lng !== "number" || !Number.isFinite(l.lng) || l.lng < -180 || l.lng > 180)) return undefined;
    }
    return body;
  } catch {
    return undefined;
  }
}

interface PendingCommand {
  commandId: string;
  scriptId: string;
}

const MAX_COMMANDS_PER_HEARTBEAT = 3;

/**
 * Marca como `delivered` (condicional, así cada comando se entrega una sola
 * vez aunque lleguen dos heartbeats juntos) y devuelve los pendientes. Los
 * pedidos los crea el operador directo en la tabla; ver `commandCatalog.ts`.
 */
async function claimPendingCommands(tenantId: string, agentId: string): Promise<PendingCommand[]> {
  const recent = await ddb.send(new QueryCommand({
    TableName: AGENTS_TABLE,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": commandSkPrefix(agentId) },
    ScanIndexForward: false,
    Limit: 20,
  }));
  const cutoff = new Date(Date.now() - COMMAND_MAX_AGE_MS).toISOString();
  const pending = ((recent.Items ?? []) as AgentCommandRecord[])
    .filter((c) => c.status === "pending" && c.createdAt >= cutoff)
    .reverse() // el más viejo primero
    .slice(0, MAX_COMMANDS_PER_HEARTBEAT);

  const claimed: PendingCommand[] = [];
  for (const command of pending) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: AGENTS_TABLE,
        Key: commandKey(tenantId, agentId, command.commandId),
        UpdateExpression: "SET #status = :delivered, deliveredAt = :now",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":delivered": "delivered", ":pending": "pending", ":now": new Date().toISOString() },
      }));
      claimed.push({ commandId: command.commandId, scriptId: command.scriptId });
    } catch (err) {
      if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
    }
  }
  return claimed;
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const apiKeyId = event.requestContext.identity.apiKeyId;
  if (!apiKeyId) return { statusCode: 403, body: JSON.stringify({ error: "falta API key" }) };

  const agent = await resolveAgentByApiKeyId(apiKeyId);
  if (!agent) return { statusCode: 403, body: JSON.stringify({ error: "API key no asociada a ningún agente" }) };

  const body = parseBody(event.body);
  if (!body) return { statusCode: 400, body: JSON.stringify({ error: "heartbeat inválido" }) };

  const now = new Date().toISOString();
  const names: Record<string, string> = { "#lastSeenAt": "lastSeenAt" };
  const values: Record<string, unknown> = { ":lastSeenAt": now };
  const updates = ["#lastSeenAt = :lastSeenAt"];
  for (const field of ["name", "version", "location"] as const) {
    const value = body[field];
    if (value === undefined) continue;
    names[`#${field}`] = field;
    values[`:${field}`] = typeof value === "string" ? value.trim() : value;
    updates.push(`#${field} = :${field}`);
  }

  await ddb.send(new UpdateCommand({
    TableName: AGENTS_TABLE,
    Key: agentKey(agent.tenantId, agent.agentId),
    UpdateExpression: `SET ${updates.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));

  // Pedir los comandos es secundario: si falla, el heartbeat (lo importante)
  // ya quedó registrado y el agente reintenta en el próximo.
  let commands: PendingCommand[] = [];
  try {
    commands = await claimPendingCommands(agent.tenantId, agent.agentId);
  } catch (err) {
    console.error("No se pudieron consultar los comandos pendientes del agente", err);
  }
  if (commands.length === 0) return { statusCode: 204, body: "" };
  return jsonResponse(200, { commands });
}
