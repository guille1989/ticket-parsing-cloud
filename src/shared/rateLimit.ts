import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { ddb } from "./dynamo.js";

/**
 * Incrementa un contador acotado con una sola escritura condicional
 * atómica — mismo patrón que el canje de códigos de activación
 * (`agents/activateHandler.ts`): la condición se evalúa contra el valor
 * ANTES del incremento, así que dos requests simultáneos no pueden colarse
 * los dos por encima del límite. `ttl` expira el item solo (DynamoDB TTL),
 * no hace falta ningún job de limpieza. Reusado por `assistant/rateLimit.ts`
 * y `signup/rateLimit.ts` — cada uno define su propia tabla, ventanas y
 * límites, esto solo hace la escritura atómica en sí.
 */
export async function incrementWithCap(tableName: string, pk: string, limit: number, ttlSeconds: number): Promise<boolean> {
  const ttl = Math.floor(Date.now() / 1000) + ttlSeconds;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
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
