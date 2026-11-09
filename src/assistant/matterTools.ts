import { GetCommand } from "@aws-sdk/lib-dynamodb";

import { addDays } from "../advisor/detectors/stats.js";
import { internalMatterId, loadBranchLabels, toPublicMatter } from "../advisor/matterApi.js";
import { listMatters, parseMatterId } from "../advisor/matterStore.js";
import type { MatterDetector, MatterItem, MatterSeverity, MatterStatus } from "../advisor/types.js";
import { ddb, MATTERS_TABLE, matterKey } from "../shared/dynamo.js";

const LIST_MATTERS_DEFAULT_DAYS = 14;
const LIST_MATTERS_MAX_DAYS = 90;
const LIST_MATTERS_DEFAULT_LIMIT = 10;
const LIST_MATTERS_MAX_LIMIT = 10;
const OPEN_STATUSES: readonly MatterStatus[] = ["new", "seen"];
const ALL_STATUSES: readonly MatterStatus[] = ["new", "seen", "dismissed", "resolved"];
const SEVERITY_RANK: Record<MatterSeverity, number> = { info: 0, warn: 1, critical: 2 };

/**
 * Chequeos concretos por detector — sugerencias, no diagnósticos. El modelo
 * no debe afirmar causas de hardware/POS; solo proponer qué revisar.
 */
export function matterChecks(detector: MatterDetector): string[] {
  switch (detector) {
    case "agent_offline":
      return [
        "Revisá que el equipo del robot esté encendido",
        "Revisá internet / cable de red",
        "Confirmá en Agentes si el robot sigue offline",
      ];
    case "capture_zero":
      return [
        "Revisá la impresora o el cable hacia el POS",
        "Confirmá que el POS esté imprimiendo tickets",
        "Revisá en Agentes si siguen entrando capturas",
      ];
    case "review_backlog":
      return [
        "Abrí Agentes y revisá la cola needs_review",
        "Confirmá o descartá los tickets pendientes",
      ];
    case "data_integrity":
      return [
        "Revisá si el POS cambió el formato del ticket",
        "Revisá en Agentes los tickets failed recientes",
      ];
    case "sales_anomaly":
      return [
        "Contrastá con ventas del mismo día/semana vía run_widget_query",
        "Revisá si hubo cierre, feriado o captura incompleta",
        "Confirmá en Agentes que los robots de esa sucursal capturaron",
      ];
    default:
      return ["Confirmá el aviso en la UI de Innova / Agentes"];
  }
}

function parseStatusFilter(raw: unknown): MatterStatus[] {
  if (raw === undefined) return [...OPEN_STATUSES];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`status inválido: se esperaba un array de ${OPEN_STATUSES.join("|")}`);
  }
  const statuses: MatterStatus[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !(ALL_STATUSES as readonly string[]).includes(item)) {
      throw new Error(`status inválido "${String(item)}": válidos ${ALL_STATUSES.join(", ")}`);
    }
    statuses.push(item as MatterStatus);
  }
  return statuses;
}

function parseDays(raw: unknown): number {
  if (raw === undefined) return LIST_MATTERS_DEFAULT_DAYS;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new Error(`days inválido: entero 1–${LIST_MATTERS_MAX_DAYS}`);
  }
  return Math.min(raw, LIST_MATTERS_MAX_DAYS);
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) return LIST_MATTERS_DEFAULT_LIMIT;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new Error(`limit inválido: entero 1–${LIST_MATTERS_MAX_LIMIT}`);
  }
  return Math.min(raw, LIST_MATTERS_MAX_LIMIT);
}

/** Lista avisos del tenant (whitelist; sin SQL). Por defecto solo abiertos (new/seen). */
export async function listMattersTool(input: unknown, tenantId: string): Promise<unknown> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const statuses = parseStatusFilter(raw.status);
  const days = parseDays(raw.days);
  const limit = parseLimit(raw.limit);

  const today = new Date().toISOString().slice(0, 10);
  const items = await listMatters(tenantId, addDays(today, -days));
  const visible = items
    .filter((item) => statuses.includes(item.status))
    .sort((a, b) => (a.periodDate === b.periodDate ? SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] : 0))
    .slice(0, limit);

  const labels = visible.some((item) => item.scope.startsWith("branch:"))
    ? await loadBranchLabels(tenantId)
    : new Map<string, string>();

  return {
    matters: visible.map((item) => {
      const pub = toPublicMatter(item, labels);
      return {
        id: pub.id,
        detector: pub.detector,
        severity: pub.severity,
        status: pub.status,
        scope: pub.scope,
        branchLabel: pub.branchLabel,
        periodDate: pub.periodDate,
        title: pub.title,
        detail: pub.detail,
        expected: pub.expected,
        actual: pub.actual,
      };
    }),
    openCount: items.filter((item) => item.status === "new" || item.status === "seen").length,
    newCount: items.filter((item) => item.status === "new").length,
    note: "Cifras y textos vienen del Advisor; no inventes causas. Para detalle de uno, usá explain_matter con su id.",
  };
}

/** Detalle de un aviso por id público (base64url), con evidence y chequeos sugeridos. */
export async function explainMatterTool(input: unknown, tenantId: string): Promise<unknown> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const matterId = typeof raw.matterId === "string" ? raw.matterId.trim() : "";
  if (!matterId) throw new Error('matterId inválido: se esperaba string no vacío');

  const internal = internalMatterId(matterId);
  if (!internal) throw new Error("matterId inválido o desconocido");
  const parsed = parseMatterId(internal);
  if (!parsed) throw new Error("matterId inválido o desconocido");

  const result = await ddb.send(
    new GetCommand({
      TableName: MATTERS_TABLE,
      Key: matterKey(tenantId, parsed.periodDate, parsed.detector, parsed.scope),
    }),
  );
  const item = result.Item as MatterItem | undefined;
  if (!item) throw new Error("aviso no encontrado");

  const labels = await loadBranchLabels(tenantId);
  const pub = toPublicMatter(item, labels);
  return {
    ...pub,
    checks: matterChecks(item.detector),
    note:
      "Las cifras (expected/actual/evidence) las calculó el detector. No inventes por qué falló hardware o POS: sugerí los chequeos y pedí confirmar en Agentes.",
  };
}
