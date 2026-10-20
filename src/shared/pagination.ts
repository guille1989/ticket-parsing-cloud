import { QueryCommand, type QueryCommandInput } from "@aws-sdk/lib-dynamodb";

import { ddb } from "./dynamo.js";

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 50;

export function parseLimit(raw: string | undefined, defaultLimit = DEFAULT_LIMIT): number {
  const parsed = raw ? Number(raw) : defaultLimit;
  if (!Number.isInteger(parsed) || parsed < 1) return defaultLimit;
  return Math.min(parsed, MAX_LIMIT);
}

export function decodeCursor(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
  } catch {
    return undefined;
  }
}

export function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  if (!key) return undefined;
  return Buffer.from(JSON.stringify(key), "utf-8").toString("base64url");
}

/**
 * Recorre todas las páginas de un Query. Para colecciones chicas por negocio
 * (widgets, agentes) que la UI necesita completas: un solo `QueryCommand` corta
 * en 1 MB y devolvería la lista truncada sin avisar.
 */
export async function queryAllPages<T>(input: Omit<QueryCommandInput, "ExclusiveStartKey">): Promise<T[]> {
  const items: T[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey }));
    items.push(...((page.Items ?? []) as T[]));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}
