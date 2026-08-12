import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { ASSISTANT_USAGE_TABLE, ddb } from "../shared/dynamo.js";

// Sin api-key en este endpoint (es Cognito, ver PROYECTO.md sección 13), el
// usage plan de API Gateway (10 rps por api-key) no aplica acá — lo único
// que protegía esta ruta era el throttling de la API entera (50 rps),
// compartido entre TODOS los tenants. Doble ventana por tenant: una corta
// (frena un loop/bug del cliente, la misma clase de falla que disparó el
// incidente de costo de S3 en la sección 10.1) y una diaria (tope de costo
// agregado por negocio).
const MINUTE_LIMIT = 6;
const DAY_LIMIT = 150;
const MINUTE_TTL_SECONDS = 120;
const DAY_TTL_SECONDS = 2 * 24 * 60 * 60;

/**
 * Incrementa un contador acotado con una sola escritura condicional
 * atómica — mismo patrón que el canje de códigos de activación
 * (`agents/activateHandler.ts`): la condición se evalúa contra el valor
 * ANTES del incremento, así que dos requests simultáneos no pueden colarse
 * los dos por encima del límite. `ttl` expira el item solo (DynamoDB TTL),
 * no hace falta ningún job de limpieza.
 */
async function incrementWithCap(pk: string, limit: number, ttlSeconds: number): Promise<boolean> {
  const ttl = Math.floor(Date.now() / 1000) + ttlSeconds;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: ASSISTANT_USAGE_TABLE,
        Key: { pk },
        UpdateExpression: "SET #ttl = if_not_exists(#ttl, :ttl) ADD #count :incr",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
        ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
        ExpressionAttributeValues: { ":incr": 1, ":limit": limit, ":ttl": ttl },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

export type RateLimitResult = { ok: true } | { ok: false; reason: "minute" | "day" };

export async function checkAssistantRateLimit(tenantId: string): Promise<RateLimitResult> {
  const now = new Date();
  const minuteBucket = Math.floor(now.getTime() / 60_000);
  const dayBucket = now.toISOString().slice(0, 10);

  const withinMinute = await incrementWithCap(`TENANT#${tenantId}#WINDOW#MIN#${minuteBucket}`, MINUTE_LIMIT, MINUTE_TTL_SECONDS);
  if (!withinMinute) return { ok: false, reason: "minute" };

  const withinDay = await incrementWithCap(`TENANT#${tenantId}#WINDOW#DAY#${dayBucket}`, DAY_LIMIT, DAY_TTL_SECONDS);
  if (!withinDay) return { ok: false, reason: "day" };

  return { ok: true };
}
