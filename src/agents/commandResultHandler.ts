import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { resolveAgentByApiKeyId } from "../shared/agent.js";
import { AGENTS_TABLE, commandKey, ddb } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import { COMMAND_ID_PATTERN, MAX_OUTPUT_CHARS } from "./commandCatalog.js";

interface ResultBody {
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function parseBody(raw: string | null): ResultBody | undefined {
  try {
    const body = JSON.parse(raw ?? "") as Partial<ResultBody>;
    if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
    if (typeof body.exitCode !== "number" || !Number.isInteger(body.exitCode)) return undefined;
    if (typeof body.durationMs !== "number" || !Number.isFinite(body.durationMs) || body.durationMs < 0) return undefined;
    if (typeof body.stdout !== "string" || typeof body.stderr !== "string") return undefined;
    return {
      exitCode: body.exitCode,
      durationMs: Math.round(body.durationMs),
      timedOut: body.timedOut === true,
      stdout: body.stdout.slice(0, MAX_OUTPUT_CHARS),
      stderr: body.stderr.slice(0, MAX_OUTPUT_CHARS),
    };
  } catch {
    return undefined;
  }
}

/**
 * El agente devuelve la salida de un diagnóstico. Solo se acepta para un
 * comando de ESE agente (el tenant y el agente salen de la API key, no del
 * body) y solo una vez: un comando que ya está `done`/`failed` no se pisa.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const apiKeyId = event.requestContext.identity.apiKeyId;
  if (!apiKeyId) return jsonResponse(403, { error: "falta API key" });

  const agent = await resolveAgentByApiKeyId(apiKeyId);
  if (!agent) return jsonResponse(403, { error: "API key no asociada a ningún agente" });

  const commandId = event.pathParameters?.commandId;
  if (!commandId || !COMMAND_ID_PATTERN.test(commandId)) return jsonResponse(400, { error: "commandId inválido" });

  const body = parseBody(event.body);
  if (!body) return jsonResponse(400, { error: "resultado inválido" });

  try {
    await ddb.send(new UpdateCommand({
      TableName: AGENTS_TABLE,
      Key: commandKey(agent.tenantId, agent.agentId, commandId),
      UpdateExpression:
        "SET #status = :status, completedAt = :completedAt, exitCode = :exitCode, durationMs = :durationMs, " +
        "timedOut = :timedOut, stdout = :stdout, stderr = :stderr",
      ConditionExpression: "#status = :delivered",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":delivered": "delivered",
        ":status": body.exitCode === 0 && !body.timedOut ? "done" : "failed",
        ":completedAt": new Date().toISOString(),
        ":exitCode": body.exitCode,
        ":durationMs": body.durationMs,
        ":timedOut": body.timedOut,
        ":stdout": body.stdout,
        ":stderr": body.stderr,
      },
    }));
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      return jsonResponse(404, { error: "comando no encontrado o ya resuelto" });
    }
    throw err;
  }

  return jsonResponse(204);
}
