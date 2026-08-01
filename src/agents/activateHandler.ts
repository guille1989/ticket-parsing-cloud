import { randomUUID } from "node:crypto";

import { CreateApiKeyCommand, CreateUsagePlanKeyCommand, GetUsagePlansCommand, APIGatewayClient } from "@aws-sdk/client-api-gateway";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { ACTIVATION_CODE_PATTERN } from "../shared/activationCode.js";
import { activationCodeKey, AGENTS_TABLE, ACTIVATION_CODES_TABLE, agentKey, ddb } from "../shared/dynamo.js";
import { ActivationCodeRecord, AgentRecord } from "../shared/types.js";

const apigw = new APIGatewayClient({});
const MAX_NAME_LENGTH = 100;

// El id del usage plan no se pasa por variable de entorno a propósito —
// ver el comentario sobre `usagePlanName` en el stack de CDK: referenciar
// el id generado por CloudFormation desde este mismo Lambda (que es parte
// de la misma API que aloja el usage plan) arma un ciclo de dependencias
// al desplegar. Se resuelve acá en runtime por nombre, una sola vez por
// entorno de ejecución tibio (Lambda reutiliza el proceso entre invocaciones).
let cachedUsagePlanId: string | undefined;

async function resolveUsagePlanId(): Promise<string> {
  if (cachedUsagePlanId) return cachedUsagePlanId;
  const usagePlanName = process.env.USAGE_PLAN_NAME ?? "";
  const result = await apigw.send(new GetUsagePlansCommand({}));
  const plan = result.items?.find((p) => p.name === usagePlanName);
  if (!plan?.id) {
    throw new Error(`no se encontró el usage plan "${usagePlanName}"`);
  }
  cachedUsagePlanId = plan.id;
  return plan.id;
}

interface ActivateBody {
  code: string;
  name?: string;
}

type BodyValidation = { ok: true; value: ActivateBody } | { ok: false; error: string };

export function validateBody(body: unknown): BodyValidation {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "se esperaba un objeto JSON" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.code !== "string" || !ACTIVATION_CODE_PATTERN.test(b.code)) {
    return { ok: false, error: "code inválido, se esperaba el formato XXXXX-XXXXX" };
  }

  let name: string | undefined;
  if (b.name !== undefined) {
    if (typeof b.name !== "string" || b.name.trim().length === 0 || b.name.length > MAX_NAME_LENGTH) {
      return { ok: false, error: `name inválido (no vacío, máx ${MAX_NAME_LENGTH} caracteres)` };
    }
    name = b.name.trim();
  }

  return { ok: true, value: { code: b.code, name } };
}

/**
 * Endpoint público — no exige API key porque el código de activación ES la
 * credencial. Cada canje mintea una API key nueva de API Gateway propia de
 * ese agente (no la api-key compartida del tenant) — así cada robot queda
 * identificable y revocable individualmente. Ver `shared/activationCode.ts`
 * y `AgentRecord`/`ActivationCodeRecord` en `shared/types.ts`.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
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
  const { code, name } = validation.value;

  let claimed;
  try {
    claimed = await ddb.send(
      new UpdateCommand({
        TableName: ACTIVATION_CODES_TABLE,
        Key: activationCodeKey(code),
        // `attribute_exists(pk)` es lo que evita que un código inventado
        // (alguien probando al azar) cree silenciosamente un item nuevo en
        // estado "used" — sin esa condición, Update crea el item si no
        // existe en vez de fallar.
        ConditionExpression: "attribute_exists(pk) AND #status = :unused",
        UpdateExpression: "SET #status = :used, usedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":unused": "unused",
          ":used": "used",
          ":now": new Date().toISOString(),
        },
        ReturnValues: "ALL_NEW",
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Mismo error para "no existe" y "ya se usó" — no hay motivo para
      // que alguien probando códigos al azar pueda distinguir los casos.
      return { statusCode: 403, body: JSON.stringify({ error: "código inválido o ya usado" }) };
    }
    throw err;
  }

  const { tenantId } = claimed.Attributes as ActivationCodeRecord;
  const agentId = randomUUID();
  const agentName = name ?? `Robot ${agentId.slice(0, 8)}`;

  const apiKey = await apigw.send(
    new CreateApiKeyCommand({ name: `agent-${agentId}`, enabled: true, generateDistinctId: true }),
  );
  if (!apiKey.id || !apiKey.value) {
    throw new Error("no se pudo crear la API key del agente");
  }
  const usagePlanId = await resolveUsagePlanId();
  await apigw.send(new CreateUsagePlanKeyCommand({ usagePlanId, keyId: apiKey.id, keyType: "API_KEY" }));

  const agent: AgentRecord = {
    tenantId,
    agentId,
    name: agentName,
    apiKeyId: apiKey.id,
    createdAt: new Date().toISOString(),
  };
  await ddb.send(
    new PutCommand({ TableName: AGENTS_TABLE, Item: { ...agent, ...agentKey(tenantId, agentId) } }),
  );

  // Mejor esfuerzo: deja registrado qué agente reclamó el código, solo para
  // poder auditarlo desde el dashboard más adelante. El agente ya quedó
  // activado igual si esto falla — no amerita revertir lo anterior por un
  // campo que es puramente de trazabilidad.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: ACTIVATION_CODES_TABLE,
        Key: activationCodeKey(code),
        UpdateExpression: "SET agentId = :agentId",
        ExpressionAttributeValues: { ":agentId": agentId },
      }),
    );
  } catch (err) {
    console.error("no se pudo anotar agentId en el código de activación", err);
  }

  return {
    statusCode: 201,
    body: JSON.stringify({ agentId, name: agentName, apiKey: apiKey.value }),
  };
}
