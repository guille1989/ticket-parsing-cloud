/*
 * Reconciliación DynamoDB ↔ copia analítica (S3/Athena) de un negocio.
 * DynamoDB es la fuente de verdad; este script detecta ventas que existen
 * como ticket pero no cuentan en las estadísticas (o al revés) y, solo con
 * --apply, las repara reescribiendo/borrando el objeto de analítica a partir
 * del ticket guardado — no vuelve a interpretar nada con OCR ni IA.
 *
 * Por defecto SOLO DIAGNOSTICA (no modifica nada).
 *
 * Detecta:
 *   missing  ticket parsed/needs_review sin objeto de analítica
 *   stale    objeto con estado/total/ítems distintos al ticket guardado
 *   orphan   objeto que no debería contar: ticket descartado/fallido, sin
 *            ticket, o en una clave distinta a la suya (duplicaría la venta)
 *
 * Con --apply:
 *   missing/stale → reescribe el objeto (idempotente)
 *   orphan discarded|failed|duplicate-key → borra el objeto
 *   orphan pending → NO se toca (puede ser un reproceso en curso)
 *   orphan unknown-ticket → NO se toca salvo --include-unknown
 *
 * Uso:
 *   npm run reconcile-analytics -- <tenantId>
 *   npm run reconcile-analytics -- <tenantId> --from 2026-10-01 --to 2026-10-31
 *   npm run reconcile-analytics -- <tenantId> --apply
 *
 * Opciones:
 *   --from/--to YYYY-MM-DD  acota por fechas; se expande a meses UTC completos
 *                           porque la analítica se particiona por año/mes
 *   --skip-content          solo compara existencia (más rápido, no detecta stale)
 *   --apply                 aplica las reparaciones
 *   --include-unknown       con --apply, borra también orphans sin ticket
 *
 * Código de salida: 0 sin diferencias (o ya reparadas), 2 si quedan diferencias.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

import {
  analyticsInputsFromTicket,
  batchedDemoKeys,
  diffAnalytics,
  fingerprintBody,
  type AnalyticsObject,
  type Discrepancy,
  type ReconTicket,
} from "../src/analytics/reconcile.js";
import { writeAnalyticsRows } from "../src/analytics/writeAnalyticsRows.js";

const REGION = "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE ?? "TicketParsingCloudStack-TicketsTableB76A19AF-1RLLAB8N38KF6";
const ANALYTICS_BUCKET = process.env.ANALYTICS_BUCKET ?? "ticketparsingcloudstack-analyticsbucket39eaaeea-sw6jw1e3882n";
const READ_CONCURRENCY = 10;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function parseDay(label: string, raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new Error(`--${label} debe ser YYYY-MM-DD (recibido: ${raw})`);
  }
  return new Date(`${raw}T00:00:00.000Z`);
}

/** Meses UTC (año/mes) que cubre el rango, ambos extremos incluidos. */
function monthsBetween(from: Date, to: Date): Array<{ year: number; month: string }> {
  const months: Array<{ year: number; month: string }> = [];
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth();
  const endYear = to.getUTCFullYear();
  const endMonth = to.getUTCMonth();
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push({ year, month: String(month + 1).padStart(2, "0") });
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return months;
}

async function loadTickets(tenantId: string, range?: { from: Date; to: Date }): Promise<ReconTicket[]> {
  // Rango expandido a meses completos: [primer instante del mes inicial, último del mes final].
  const lower = range ? new Date(Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), 1)).toISOString() : undefined;
  const upper = range
    ? new Date(Date.UTC(range.to.getUTCFullYear(), range.to.getUTCMonth() + 1, 1) - 1).toISOString()
    : undefined;

  const tickets: ReconTicket[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: TICKETS_TABLE,
        // `~` > `#`: incluye los sort keys que siguen a la fecha (`<fecha>#<ticketId>`).
        KeyConditionExpression: range ? "pk = :pk AND sk BETWEEN :lo AND :hi" : "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: range
          ? { ":pk": `TENANT#${tenantId}`, ":lo": `TICKET#${lower}`, ":hi": `TICKET#${upper}~` }
          : { ":pk": `TENANT#${tenantId}`, ":prefix": "TICKET#" },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    tickets.push(...((page.Items ?? []) as ReconTicket[]));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return tickets;
}

async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: ANALYTICS_BUCKET, Prefix: prefix, ContinuationToken: token }));
    for (const object of page.Contents ?? []) if (object.Key?.endsWith(".jsonl")) keys.push(object.Key);
    token = page.NextContinuationToken;
  } while (token);
  return keys;
}

async function readFingerprint(key: string): Promise<AnalyticsObject> {
  const result = await s3.send(new GetObjectCommand({ Bucket: ANALYTICS_BUCKET, Key: key }));
  return { key, fingerprint: fingerprintBody((await result.Body?.transformToString("utf-8")) ?? "") };
}

/** Ejecuta `task` sobre todos los elementos con a lo sumo `limit` en vuelo. */
async function mapLimited<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index]);
      }
    }),
  );
  return results;
}

function describe(d: Discrepancy): string {
  switch (d.kind) {
    case "missing":
      return `FALTA      ${d.ticketId}  (${d.ticketStatus}) no está en analítica`;
    case "stale":
      return `DESFASADO  ${d.ticketId}  ${d.differences.join("; ")}`;
    case "orphan":
      return `SOBRA      ${d.ticketId}  ${d.reason}  ${d.key}`;
  }
}

async function applyRepair(d: Discrepancy, tenantTickets: Map<string, ReconTicket>, includeUnknown: boolean): Promise<string> {
  if (d.kind === "orphan") {
    if (d.reason === "pending") return "omitido (ticket en reproceso)";
    if (d.reason === "unknown-ticket" && !includeUnknown) return "omitido (usar --include-unknown)";
    await s3.send(new DeleteObjectCommand({ Bucket: ANALYTICS_BUCKET, Key: d.key }));
    return "objeto borrado";
  }
  const inputs = analyticsInputsFromTicket(tenantTickets.get(d.ticketId)!);
  if (!inputs) return "omitido (el ticket no tiene ítems)";
  await writeAnalyticsRows(ANALYTICS_BUCKET, inputs.ctx, inputs.parsed);
  return "objeto reescrito";
}

async function main(): Promise<void> {
  const tenantId = process.argv[2];
  if (!tenantId || tenantId.startsWith("--")) {
    console.error("uso: npm run reconcile-analytics -- <tenantId> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--skip-content] [--apply] [--include-unknown]");
    process.exit(1);
  }

  const from = parseDay("from", option("from"));
  const to = parseDay("to", option("to"));
  if ((from && !to) || (!from && to)) throw new Error("--from y --to van juntos");
  if (from && to && from > to) throw new Error("--from no puede ser posterior a --to");
  const range = from && to ? { from, to } : undefined;
  const apply = flag("apply");

  console.log(`tenant ${tenantId} — ${apply ? "MODO APLICAR" : "diagnóstico (no modifica nada)"}`);
  if (range) console.log(`rango: ${option("from")} → ${option("to")} (ampliado a meses UTC completos)`);

  const prefixes = range
    ? monthsBetween(range.from, range.to).map((m) => `tenant=${tenantId}/year=${m.year}/month=${m.month}/`)
    : [`tenant=${tenantId}/`];

  const [tickets, keyLists] = await Promise.all([loadTickets(tenantId, range), Promise.all(prefixes.map(listKeys))]);
  const keys = keyLists.flat();
  console.log(`tickets en DynamoDB: ${tickets.length}   objetos de analítica: ${keys.length}`);

  const batched = batchedDemoKeys(keys);
  if (batched.length > 0) {
    console.log(`\n⚠ ${batched.length} objeto(s) "demo-*.jsonl" agrupan varios tickets: este negocio tiene datos de demo sembrados`);
    console.log("  y la reconciliación (un objeto por ticket) no aplica; los resultados serían falsos positivos.");
    if (apply) throw new Error("--apply rechazado: analítica agrupada de demo");
  }

  const skipContent = flag("skip-content");
  const objects: AnalyticsObject[] = skipContent
    ? keys.map((key) => ({ key }))
    : await mapLimited(keys, READ_CONCURRENCY, readFingerprint);

  const discrepancies = diffAnalytics(tickets, objects);
  if (discrepancies.length === 0) {
    console.log("\n✔ Sin diferencias: la analítica coincide con DynamoDB.");
    return;
  }

  const counts = { missing: 0, stale: 0, orphan: 0 };
  for (const d of discrepancies) counts[d.kind] += 1;
  console.log(`\n${discrepancies.length} diferencia(s): ${counts.missing} faltan, ${counts.stale} desfasadas, ${counts.orphan} sobran\n`);

  const byTicket = new Map(tickets.map((t) => [t.ticketId, t]));
  let remaining = 0;
  for (const d of discrepancies) {
    if (!apply) {
      console.log(describe(d));
      remaining += 1;
      continue;
    }
    try {
      const outcome = await applyRepair(d, byTicket, flag("include-unknown"));
      console.log(`${describe(d)}\n             → ${outcome}`);
      if (outcome.startsWith("omitido")) remaining += 1;
    } catch (err) {
      remaining += 1;
      console.log(`${describe(d)}\n             → ERROR: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (!apply) console.log("\nNo se modificó nada. Para reparar: repetir con --apply.");
  else console.log(`\nReparación terminada. Sin resolver: ${remaining}. Volvé a correr el diagnóstico para confirmar.`);
  if (remaining > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error("ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
