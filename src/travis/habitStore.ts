import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import { ddb, MATTERS_TABLE } from "../shared/dynamo.js";
import type { AgentHabit } from "./types.js";

// El perfil de hábitos vive en la tabla Matters con un SK que NO empieza en "MATTER#", así
// que `listMatters` (rango sobre ese prefijo) nunca lo devuelve como si fuera un asunto.
const PROFILE_SK = "PROFILE#habits";
const PROFILE_TTL_DAYS = 14;
const DAY_SECONDS = 86_400;

export interface HabitProfile {
  habits: Record<string, AgentHabit>;
  computedAt: string;
  /** Fecha local en que corrió el análisis diario: es el marcador de "hoy ya se hizo". */
  dailyDate: string;
}

export async function loadHabitProfile(tenantId: string): Promise<HabitProfile | undefined> {
  const result = await ddb.send(new GetCommand({ TableName: MATTERS_TABLE, Key: { pk: `TENANT#${tenantId}`, sk: PROFILE_SK } }));
  const item = result.Item as (HabitProfile & { pk: string; sk: string }) | undefined;
  return item ? { habits: item.habits, computedAt: item.computedAt, dailyDate: item.dailyDate } : undefined;
}

export async function saveHabitProfile(tenantId: string, profile: HabitProfile, now: Date = new Date()): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: MATTERS_TABLE,
      Item: { pk: `TENANT#${tenantId}`, sk: PROFILE_SK, ...profile, ttl: Math.floor(now.getTime() / 1000) + PROFILE_TTL_DAYS * DAY_SECONDS },
    }),
  );
}
