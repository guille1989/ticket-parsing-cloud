// Operaciones de la consola de operador sobre DynamoDB: listar negocios y
// agentes, pedir un diagnóstico y leer su resultado. Las usan tanto el
// servidor local (`server.ts`) como la CLI (`../agent-command.ts`).
//
// Se escribe directo en la tabla Agents con las credenciales de AWS del
// operador — no hay endpoint público para pedir diagnósticos a propósito (ver
// `src/agents/commandCatalog.ts`).
import { GetCommand, PutCommand, QueryCommand, ScanCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import {
  COMMAND_MAX_AGE_MS,
  COMMAND_TTL_SECONDS,
  DIAGNOSTIC_SCRIPTS,
  isDiagnosticScriptId,
  newCommandId,
} from "../../src/agents/commandCatalog.js";
import { agentKey, commandKey, commandSkPrefix } from "../../src/shared/dynamo.js";
import type { AgentCommandRecord, AgentRecord } from "../../src/shared/types.js";

export interface AdminTables {
  agents: string;
  tenants: string;
}

export class AdminError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Primera versión del agente que entiende diagnósticos remotos. */
export const MIN_DIAGNOSTIC_VERSION = "0.5.0";
/** Un agente manda heartbeat cada 60 s; pasados 3 minutos se lo da por desconectado. */
export const ONLINE_WINDOW_MS = 3 * 60 * 1000;
const MAX_OPEN_COMMANDS = 5;

export function versionAtLeast(version: string | undefined, minimum: string): boolean {
  if (!version) return false;
  const parse = (v: string) => v.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(version);
  const b = parse(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

/**
 * Elige un elemento por id exacto, prefijo de id o parte del nombre (sin
 * mayúsculas ni acentos). Si hay más de uno o ninguno, falla diciendo cuáles
 * son — la CLI lo usa para no obligar a copiar UUIDs.
 */
export function pickOne<T>(items: T[], query: string, id: (item: T) => string, name: (item: T) => string, what: string): T {
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const q = fold(query);
  const exact = items.filter((i) => id(i) === query);
  const matches = exact.length ? exact : items.filter((i) => id(i).startsWith(query) || fold(name(i)).includes(q));
  if (matches.length === 1) return matches[0] as T;
  const options = (matches.length ? matches : items).map((i) => `  - ${name(i)} (${id(i)})`).join("\n");
  throw new AdminError(
    matches.length ? 409 : 404,
    matches.length ? `"${query}" coincide con varios ${what}:\n${options}` : `ningún ${what} coincide con "${query}". Disponibles:\n${options}`,
  );
}

export interface TenantSummary {
  tenantId: string;
  businessName: string;
  status: string;
  createdAt?: string;
}

export interface AgentSummary {
  agentId: string;
  name: string;
  version?: string;
  lastSeenAt?: string;
  location?: AgentRecord["location"];
  online: boolean;
  /** `false` = versión sin la capacidad: un pedido se quedaría esperando para siempre. */
  canDiagnose: boolean;
}

export function createAdminData(ddb: DynamoDBDocumentClient, tables: AdminTables, clock: () => Date = () => new Date()) {
  async function listTenants(): Promise<TenantSummary[]> {
    const items: Array<Partial<TenantSummary>> = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(new ScanCommand({ TableName: tables.tenants, ExclusiveStartKey: exclusiveStartKey }));
      items.push(...((page.Items ?? []) as Array<Partial<TenantSummary>>));
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items
      .filter((t): t is Partial<TenantSummary> & { tenantId: string } => typeof t.tenantId === "string")
      .map((t) => ({
        tenantId: t.tenantId,
        businessName: t.businessName ?? "(sin nombre)",
        status: t.status ?? "active",
        createdAt: t.createdAt,
      }))
      .sort((a, b) => a.businessName.localeCompare(b.businessName));
  }

  async function listAgents(tenantId: string): Promise<AgentSummary[]> {
    const result = await ddb.send(new QueryCommand({
      TableName: tables.agents,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": "AGENT#" },
    }));
    const now = clock().getTime();
    return ((result.Items ?? []) as AgentRecord[])
      .map((a) => ({
        agentId: a.agentId,
        name: a.name,
        version: a.version,
        lastSeenAt: a.lastSeenAt,
        location: a.location,
        online: !!a.lastSeenAt && now - Date.parse(a.lastSeenAt) <= ONLINE_WINDOW_MS,
        canDiagnose: versionAtLeast(a.version, MIN_DIAGNOSTIC_VERSION),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function listCommands(tenantId: string, agentId: string, limit = 20): Promise<AgentCommandRecord[]> {
    const result = await ddb.send(new QueryCommand({
      TableName: tables.agents,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":prefix": commandSkPrefix(agentId) },
      ScanIndexForward: false, // más recientes primero
      Limit: limit,
    }));
    return (result.Items ?? []) as AgentCommandRecord[];
  }

  async function getCommand(tenantId: string, agentId: string, commandId: string): Promise<AgentCommandRecord | undefined> {
    const result = await ddb.send(new GetCommand({ TableName: tables.agents, Key: commandKey(tenantId, agentId, commandId) }));
    return result.Item as AgentCommandRecord | undefined;
  }

  /** Crea un pedido `pending`; el agente lo recibe en su próximo heartbeat (hasta ~1 min). */
  async function createCommand(tenantId: string, agentId: string, scriptId: unknown): Promise<AgentCommandRecord> {
    if (!isDiagnosticScriptId(scriptId)) throw new AdminError(400, "scriptId desconocido");

    const agent = await ddb.send(new GetCommand({ TableName: tables.agents, Key: agentKey(tenantId, agentId) }));
    if (!agent.Item) throw new AdminError(404, "agente no encontrado");

    const now = clock();
    const cutoff = new Date(now.getTime() - COMMAND_MAX_AGE_MS).toISOString();
    const open = (await listCommands(tenantId, agentId)).filter(
      (c) => (c.status === "pending" || c.status === "delivered") && c.createdAt >= cutoff,
    );
    if (open.length >= MAX_OPEN_COMMANDS) throw new AdminError(429, "hay demasiados diagnósticos sin resolver para este agente");

    const commandId = newCommandId(now.getTime());
    const record: AgentCommandRecord = {
      tenantId,
      agentId,
      commandId,
      scriptId,
      status: "pending",
      createdAt: now.toISOString(),
      ttl: Math.floor(now.getTime() / 1000) + COMMAND_TTL_SECONDS,
    };
    await ddb.send(new PutCommand({
      TableName: tables.agents,
      Item: { ...commandKey(tenantId, agentId, commandId), ...record },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
    return record;
  }

  return { listTenants, listAgents, listCommands, getCommand, createCommand, catalog: DIAGNOSTIC_SCRIPTS };
}

export type AdminData = ReturnType<typeof createAdminData>;
