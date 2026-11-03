import { describeMatter } from "./describeMatter.js";
import { loadAgents } from "./opsData.js";
import { matterIdOf, parseMatterId } from "./matterStore.js";
import type { MatterItem } from "./types.js";

/**
 * El id interno de un asunto (`2026-11-04#agent_offline#branch:abc`) lleva `#` y `:`, y API
 * Gateway REST entrega los path parameters sin decodificar (ver `reportIdParam.ts`). Hacia
 * afuera viaja en base64url: solo letras, números, `-` y `_`, que llegan intactos.
 */
export function publicMatterId(item: Pick<MatterItem, "periodDate" | "detector" | "scope">): string {
  return Buffer.from(matterIdOf(item), "utf-8").toString("base64url");
}

/** Devuelve el id interno si el público es válido; `null` si es basura. */
export function internalMatterId(publicId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,300}$/.test(publicId)) return null;
  const decoded = Buffer.from(publicId, "base64url").toString("utf-8");
  return parseMatterId(decoded) ? decoded : null;
}

/** Nombre legible de cada sucursal (agentId → etiqueta de ubicación, o el nombre del robot). */
export async function loadBranchLabels(tenantId: string): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  for (const agent of await loadAgents(tenantId)) {
    labels.set(agent.agentId, agent.location?.label ?? agent.location?.city ?? agent.name);
  }
  return labels;
}

/** Lo que ve el dashboard: sin claves internas de DynamoDB, TTL ni tenantId. */
export function toPublicMatter(item: MatterItem, branchLabels: ReadonlyMap<string, string>) {
  const agentId = item.scope.startsWith("branch:") ? item.scope.slice("branch:".length) : undefined;
  const branchLabel = agentId ? (branchLabels.get(agentId) ?? null) : null;
  return {
    id: publicMatterId(item),
    detector: item.detector,
    scope: item.scope,
    branchLabel,
    // Texto ya redactado: lo comparten la pantalla y la voz (ver describeMatter.ts).
    ...describeMatter(item, branchLabel),
    periodDate: item.periodDate,
    severity: item.severity,
    status: item.status,
    expected: item.expected ?? null,
    actual: item.actual ?? null,
    evidence: item.evidence,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    seenAt: item.seenAt ?? null,
    resolvedAt: item.resolvedAt ?? null,
  };
}
