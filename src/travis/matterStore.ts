import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { ddb, MATTERS_TABLE, matterKey } from "../shared/dynamo.js";
import { queryAllPages } from "../shared/pagination.js";
import { addDays } from "./detectors/stats.js";
import {
  isValidMatterScope,
  MATTER_DETECTORS,
  MATTER_RETENTION_DAYS,
  type MatterCandidate,
  type MatterDetector,
  type MatterItem,
  type MatterSeverity,
} from "./types.js";

// Ciclo de vida de un asunto:
//   new ──(el dueño lo ve)──▶ seen ──(lo descarta)──▶ dismissed
//   new/seen ──(la condición desaparece)──▶ resolved ──(reaparece)──▶ new
// La clave es determinista (fecha local + detector + alcance), así que correr el job varias
// veces el mismo día reescribe el mismo asunto: nunca lo duplica.

/**
 * Detectores que describen un ESTADO que dura (robot caído, cola acumulada...): se resuelven
 * solos cuando la condición se va, y un "descartado" sigue valiendo mientras el problema
 * continúa al día siguiente. La venta anómala, en cambio, es un evento de un día concreto.
 */
export const STATEFUL_DETECTORS: readonly MatterDetector[] = ["agent_offline", "capture_zero", "review_backlog", "data_integrity"];

const SEVERITY_RANK: Record<MatterSeverity, number> = { info: 0, warn: 1, critical: 2 };
const DAY_SECONDS = 86_400;

export type MatterChange = "created" | "updated" | "reopened";
export interface UpsertResult {
  item: MatterItem;
  /** `created` y `reopened` son los que merecen avisar al dueño; `updated` solo refresca las cifras. */
  change: MatterChange;
}

function isConditionalFailure(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === "ConditionalCheckFailedException";
}

async function getMatter(tenantId: string, periodDate: string, detector: string, scope: string): Promise<MatterItem | undefined> {
  const result = await ddb.send(new GetCommand({ TableName: MATTERS_TABLE, Key: matterKey(tenantId, periodDate, detector, scope) }));
  return result.Item as MatterItem | undefined;
}

/** Un descartado de ayer sigue descartado hoy si el mismo problema continúa sin empeorar. */
async function inheritedStatus(tenantId: string, candidate: MatterCandidate): Promise<"new" | "dismissed"> {
  if (!STATEFUL_DETECTORS.includes(candidate.detector)) return "new";
  const previous = await getMatter(tenantId, addDays(candidate.periodDate, -1), candidate.detector, candidate.scope);
  const unchanged = previous?.status === "dismissed" && SEVERITY_RANK[candidate.severity] <= SEVERITY_RANK[previous.severity];
  return unchanged ? "dismissed" : "new";
}

/**
 * Guarda lo que detectaron los detectores. Un asunto nuevo queda en `new`; uno que ya existía
 * refresca sus cifras y conserva su estado, salvo que haya reaparecido tras resolverse o
 * empeorado de severidad después de que el dueño lo viera: en esos casos vuelve a `new`.
 */
export async function upsertMatters(tenantId: string, candidates: MatterCandidate[], now: Date = new Date()): Promise<UpsertResult[]> {
  const iso = now.toISOString();
  const ttl = Math.floor(now.getTime() / 1000) + MATTER_RETENTION_DAYS * DAY_SECONDS;
  const results: UpsertResult[] = [];

  for (const candidate of candidates) {
    if (!isValidMatterScope(candidate.scope)) throw new Error(`scope inválido para un asunto: "${candidate.scope}"`);
    const key = matterKey(tenantId, candidate.periodDate, candidate.detector, candidate.scope);
    const fields = {
      tenantId,
      detector: candidate.detector,
      scope: candidate.scope,
      periodDate: candidate.periodDate,
      severity: candidate.severity,
      evidence: candidate.evidence,
      // DynamoDB rechaza `undefined`: los opcionales se omiten.
      ...(candidate.expected !== undefined ? { expected: candidate.expected } : {}),
      ...(candidate.actual !== undefined ? { actual: candidate.actual } : {}),
    };

    const existing = await getMatter(tenantId, candidate.periodDate, candidate.detector, candidate.scope);
    let item: MatterItem;
    let change: MatterChange;
    if (!existing) {
      item = { ...key, ...fields, status: await inheritedStatus(tenantId, candidate), createdAt: iso, updatedAt: iso, ttl };
      change = "created";
    } else {
      const escalated = existing.status !== "new" && SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[existing.severity];
      const reopened = existing.status === "resolved" || escalated;
      item = {
        ...key,
        ...fields,
        status: reopened ? "new" : existing.status,
        createdAt: existing.createdAt,
        updatedAt: iso,
        ttl: existing.ttl,
        ...(existing.seenAt ? { seenAt: existing.seenAt } : {}),
      };
      change = reopened ? "reopened" : "updated";
    }
    await ddb.send(new PutCommand({ TableName: MATTERS_TABLE, Item: item }));
    results.push({ item, change });
  }
  return results;
}

/**
 * Marca como `resolved` los asuntos de estado que dejaron de detectarse. Mira hoy y ayer: un
 * asunto abierto de ayer se cierra (si el problema sigue, hoy tiene su propio asunto). Solo
 * se resuelve lo de los detectores que corrieron en esta pasada: si uno falló, no se sabe
 * si la condición terminó. Un asunto `dismissed` no se toca.
 */
export async function resolveClearedMatters(
  tenantId: string,
  today: string,
  ranDetectors: readonly MatterDetector[],
  activeKeys: ReadonlySet<string>,
  now: Date = new Date(),
): Promise<number> {
  const iso = now.toISOString();
  const resolvable = STATEFUL_DETECTORS.filter((detector) => ranDetectors.includes(detector));
  if (resolvable.length === 0) return 0;

  let resolved = 0;
  for (const day of [today, addDays(today, -1)]) {
    const items = await queryAllPages<MatterItem>({
      TableName: MATTERS_TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": `MATTER#${day}#` },
    });
    for (const item of items) {
      if (!resolvable.includes(item.detector) || activeKeys.has(item.sk)) continue;
      if (item.status !== "new" && item.status !== "seen") continue;
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: MATTERS_TABLE,
            Key: { pk: item.pk, sk: item.sk },
            UpdateExpression: "SET #status = :resolved, resolvedAt = :now, updatedAt = :now",
            // Si el dueño lo marcó entretanto, esa acción gana: no se pisa.
            ConditionExpression: "attribute_exists(pk) AND #status = :expected",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: { ":resolved": "resolved", ":now": iso, ":expected": item.status },
          }),
        );
        resolved++;
      } catch (err) {
        if (!isConditionalFailure(err)) throw err;
      }
    }
  }
  return resolved;
}

/** Asuntos desde `sinceDate` (yyyy-MM-dd, fecha local), el más reciente primero. */
export async function listMatters(tenantId: string, sinceDate: string): Promise<MatterItem[]> {
  return queryAllPages<MatterItem>({
    TableName: MATTERS_TABLE,
    KeyConditionExpression: "pk = :pk AND sk >= :since AND sk < :until",
    // "MATTER$" va justo después de "MATTER#": cota superior de todos los SK de asuntos.
    ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":since": `MATTER#${sinceDate}`, ":until": "MATTER$" },
    ScanIndexForward: false,
  });
}

/** Identificador público de un asunto (el SK sin el prefijo): lo que viaja en la URL del dashboard. */
export function matterIdOf(item: Pick<MatterItem, "periodDate" | "detector" | "scope">): string {
  return `${item.periodDate}#${item.detector}#${item.scope}`;
}

export function parseMatterId(id: string): { periodDate: string; detector: MatterDetector; scope: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})#([a-z_]+)#(.+)$/.exec(id);
  if (!match) return null;
  const [, periodDate, detector, scope] = match;
  if (!(MATTER_DETECTORS as readonly string[]).includes(detector) || !isValidMatterScope(scope)) return null;
  return { periodDate, detector: detector as MatterDetector, scope };
}

export type MatterAction = "seen" | "dismissed";
export type MarkMatterResult = { ok: true; item: MatterItem } | { ok: false; reason: "not_found" | "resolved" | "conflict" };

/** Lo que hace el dueño desde el dashboard: marcarlo como visto o descartarlo (y deshacerlo con la otra acción). */
export async function markMatter(tenantId: string, matterId: string, action: MatterAction, now: Date = new Date()): Promise<MarkMatterResult> {
  const parsed = parseMatterId(matterId);
  if (!parsed) return { ok: false, reason: "not_found" };
  const existing = await getMatter(tenantId, parsed.periodDate, parsed.detector, parsed.scope);
  if (!existing) return { ok: false, reason: "not_found" };
  // Un asunto resuelto ya no es accionable: la condición desapareció sola.
  if (existing.status === "resolved") return { ok: false, reason: "resolved" };

  const iso = now.toISOString();
  try {
    const result = await ddb.send(
      new UpdateCommand({
        TableName: MATTERS_TABLE,
        Key: { pk: existing.pk, sk: existing.sk },
        UpdateExpression: "SET #status = :status, seenAt = :seenAt, updatedAt = :now",
        ConditionExpression: "attribute_exists(pk) AND #status = :expected",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":status": action, ":seenAt": existing.seenAt ?? iso, ":now": iso, ":expected": existing.status },
        ReturnValues: "ALL_NEW",
      }),
    );
    return { ok: true, item: result.Attributes as MatterItem };
  } catch (err) {
    if (isConditionalFailure(err)) return { ok: false, reason: "conflict" };
    throw err;
  }
}
