import { randomUUID } from "node:crypto";

import {
  APIGatewayClient,
  ConflictException,
  CreateApiKeyCommand,
  CreateUsagePlanKeyCommand,
  GetApiKeysCommand,
  GetUsagePlansCommand,
} from "@aws-sdk/client-api-gateway";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { ACTIVATION_CODE_PATTERN } from "../shared/activationCode.js";
import { activationCodeKey, AGENTS_TABLE, ACTIVATION_CODES_TABLE, agentKey, ddb } from "../shared/dynamo.js";
import { ActivationCodeRecord, AgentRecord } from "../shared/types.js";

const apigw = new APIGatewayClient({});
const MAX_NAME_LENGTH = 100;

/** Lo que dura la reserva de una activación en curso; un reintento antes de que venza recibe 409. */
const LEASE_MS = 30_000;

/**
 * Si la respuesta 201 se perdió (corte de conexión), el agente puede reintentar
 * con el mismo código y recibir el MISMO resultado, pero solo mientras no haya
 * demostrado haber recibido la credencial (su primer heartbeat) y dentro de esta
 * ventana. Pasada la ventana, un código usado vuelve a ser inútil.
 */
const RECOVERY_WINDOW_MS = 15 * 60_000;

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

interface ActivationResult {
  agentId: string;
  name: string;
  apiKey: string;
}

const json = (statusCode: number, body: unknown): APIGatewayProxyResult => ({ statusCode, body: JSON.stringify(body) });

async function findApiKey(name: string): Promise<{ id: string; value: string } | undefined> {
  const result = await apigw.send(new GetApiKeysCommand({ nameQuery: name, includeValues: true }));
  const key = result.items?.find((item) => item.name === name);
  return key?.id && key.value ? { id: key.id, value: key.value } : undefined;
}

/**
 * Crea (o reanuda) todo lo que necesita el agente reservado. Cada paso es
 * idempotente respecto del `agentId`, para que reintentar tras un fallo parcial
 * complete la activación en vez de crear otro agente u otra credencial.
 */
async function provisionAgent(tenantId: string, agentId: string, requestedName: string | undefined): Promise<ActivationResult> {
  const keyName = `agent-${agentId}`;

  let apiKey = await findApiKey(keyName);
  if (!apiKey) {
    const created = await apigw.send(new CreateApiKeyCommand({ name: keyName, enabled: true, generateDistinctId: true }));
    if (!created.id || !created.value) {
      throw new Error("no se pudo crear la API key del agente");
    }
    apiKey = { id: created.id, value: created.value };
  }

  const usagePlanId = await resolveUsagePlanId();
  try {
    await apigw.send(new CreateUsagePlanKeyCommand({ usagePlanId, keyId: apiKey.id, keyType: "API_KEY" }));
  } catch (err) {
    // Un intento anterior ya la vinculó al plan: es el estado que se busca.
    if (!(err instanceof ConflictException)) throw err;
  }

  let name = requestedName ?? `Robot ${agentId.slice(0, 8)}`;
  const agent: AgentRecord = { tenantId, agentId, name, apiKeyId: apiKey.id, createdAt: new Date().toISOString() };
  try {
    await ddb.send(
      new PutCommand({
        TableName: AGENTS_TABLE,
        Item: { ...agent, ...agentKey(tenantId, agentId) },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
    // Ya lo creó un intento anterior: se conserva tal cual (nombre incluido).
    const existing = await ddb.send(new GetCommand({ TableName: AGENTS_TABLE, Key: agentKey(tenantId, agentId), ConsistentRead: true }));
    name = (existing.Item as AgentRecord | undefined)?.name ?? name;
  }

  return { agentId, name, apiKey: apiKey.value };
}

/**
 * Un código ya `used` cuya respuesta se perdió: devuelve el mismo agente y la misma
 * credencial si el agente todavía no se comunicó y la ventana sigue abierta.
 */
async function recoverLostActivation(code: ActivationCodeRecord): Promise<ActivationResult | undefined> {
  if (!code.agentId || !code.usedAt || Date.now() - Date.parse(code.usedAt) > RECOVERY_WINDOW_MS) return undefined;

  const stored = await ddb.send(
    new GetCommand({ TableName: AGENTS_TABLE, Key: agentKey(code.tenantId, code.agentId), ConsistentRead: true }),
  );
  const agent = stored.Item as AgentRecord | undefined;
  // Si ya hubo un heartbeat, la credencial se entregó: no hay nada que recuperar.
  if (!agent || agent.lastSeenAt) return undefined;

  const apiKey = await findApiKey(`agent-${agent.agentId}`);
  return apiKey ? { agentId: agent.agentId, name: agent.name, apiKey: apiKey.value } : undefined;
}

/**
 * Endpoint público — no exige API key porque el código de activación ES la
 * credencial. Cada canje mintea una API key nueva de API Gateway propia de
 * ese agente (no la api-key compartida del tenant) — así cada robot queda
 * identificable y revocable individualmente. Ver `shared/activationCode.ts`
 * y `AgentRecord`/`ActivationCodeRecord` en `shared/types.ts`.
 *
 * El canje no es atómico (la API key vive en API Gateway, no en DynamoDB), así
 * que es recuperable: el código pasa por `unused → activating → used`. Al
 * reclamarlo se reserva el `agentId` y un lease corto; si algo falla después,
 * el reintento con el mismo código reanuda con ese mismo agente en vez de
 * gastar otro código o dejar recursos huérfanos. Un código sigue siendo de un
 * solo uso: recuperar nunca crea un segundo agente.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  let body: unknown;
  try {
    body = event.body ? JSON.parse(event.body) : null;
  } catch {
    return json(400, { error: "body inválido, se esperaba JSON" });
  }

  const validation = validateBody(body);
  if (!validation.ok) {
    return json(400, { error: validation.error });
  }
  const { code, name } = validation.value;

  let claimed;
  try {
    claimed = await ddb.send(
      new UpdateCommand({
        TableName: ACTIVATION_CODES_TABLE,
        Key: activationCodeKey(code),
        // `attribute_exists(pk)` es lo que evita que un código inventado
        // (alguien probando al azar) cree silenciosamente un item nuevo —
        // sin esa condición, Update crea el item si no existe en vez de fallar.
        // Se puede reclamar un código sin usar o uno cuya activación anterior
        // quedó a medias (lease vencido); nunca uno usado ni uno en curso.
        ConditionExpression: "attribute_exists(pk) AND (#status = :unused OR (#status = :activating AND activatingUntil < :nowMs))",
        // `if_not_exists`: un reintento conserva el agentId reservado la primera vez.
        UpdateExpression: "SET #status = :activating, activatingUntil = :until, agentId = if_not_exists(agentId, :agentId)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":unused": "unused",
          ":activating": "activating",
          ":nowMs": Date.now(),
          ":until": Date.now() + LEASE_MS,
          ":agentId": randomUUID(),
        },
        ReturnValues: "ALL_NEW",
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException)) throw err;

    const current = await ddb.send(
      new GetCommand({ TableName: ACTIVATION_CODES_TABLE, Key: activationCodeKey(code), ConsistentRead: true }),
    );
    const record = current.Item as ActivationCodeRecord | undefined;
    if (record?.status === "activating") {
      return json(409, { error: "hay una activación en curso con este código, reintentá en unos segundos" });
    }
    if (record?.status === "used") {
      const recovered = await recoverLostActivation(record);
      if (recovered) return json(201, recovered);
    }
    // Mismo error para "no existe" y "ya se usó" — no hay motivo para
    // que alguien probando códigos al azar pueda distinguir los casos.
    return json(403, { error: "código inválido o ya usado" });
  }

  const { tenantId, agentId } = claimed.Attributes as ActivationCodeRecord & { agentId: string };
  const result = await provisionAgent(tenantId, agentId, name);

  // Cierra el canje. Si esto falla, el código queda en `activating` y el
  // reintento (tras el lease) reanuda y vuelve a llegar acá.
  await ddb.send(
    new UpdateCommand({
      TableName: ACTIVATION_CODES_TABLE,
      Key: activationCodeKey(code),
      UpdateExpression: "SET #status = :used, usedAt = :now, agentId = :agentId REMOVE activatingUntil",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":used": "used", ":now": new Date().toISOString(), ":agentId": agentId },
    }),
  );

  return json(201, result);
}
