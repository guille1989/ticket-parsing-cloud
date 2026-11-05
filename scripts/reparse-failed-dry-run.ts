/*
 * CORRIDA EN SECO del reproceso de tickets `failed` de un tenant con la lógica
 * de parseo ACTUAL. No escribe nada en DynamoDB/S3: solo lee y llama a Bedrock.
 * Replica lo que hace `parseTicket` para un ticket-imagen (visión → ¿informe de
 * caja? → coherencia económica) y guarda el resultado completo en
 * <out>/dry-run.json, más una tabla para revisar (tabla.csv).
 *
 * Por qué en seco: Bedrock no es determinista entre corridas, así que lo que se
 * revisa es lo que se aplica (desde el archivo, sin volver a llamar al modelo).
 *
 * Marca los "posibles duplicados": un ticket recuperable con el mismo total que
 * otro ya contado (parsed/needs_review) capturado a ±10 min. Si el agente subió
 * la misma factura dos veces, recuperar el fallido contaría la venta dos veces.
 *
 * Se omiten los fallidos por "reporte de caja" (informe diario): esos deben
 * seguir failed. Tickets que no son imagen se omiten (no pasan por visión).
 *
 * Uso:
 *   npm run reparse-failed-dry-run -- <tenantId> [--limit N] [--out <carpeta>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { isNotASale } from "../src/parsing/bedrockShared.js";
import { checkEconomicCoherence } from "../src/parsing/economicCoherence.js";
import { extractRasterTiles, looksRasterDominant, readEscpos } from "../src/parsing/escpos.js";
import type { ParsedTicket } from "../src/parsing/types.js";

const REGION = "us-east-1";
// El cliente de Bedrock del módulo toma la región al importarse.
process.env.AWS_REGION ??= REGION;

const TICKETS_TABLE = process.env.TICKETS_TABLE ?? "TicketParsingCloudStack-TicketsTableB76A19AF-1RLLAB8N38KF6";
const RAW_BUCKET = process.env.RAW_BUCKET ?? "ticketparsingcloudstack-rawticketsbucket6ab163e9-gozelnd9h2h9";
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const CONCURRENCY = Number(process.env.REPARSE_CONCURRENCY ?? 2);
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });

type Outcome = "recuperable" | "informe-de-caja" | "sigue-fallando" | "no-imagen" | "error";

interface Entry {
  ticketId: string;
  pk: string;
  sk: string;
  capturedAt: string;
  oldReason: string;
  outcome: Outcome;
  /** Resultado del parseo actual: lo que se escribiría (solo `recuperable`). */
  ticket?: ParsedTicket;
  /** Por qué sigue fallando (o el error de la corrida). */
  newReason?: string;
  /** ticketId de tickets ya contados con el mismo total a ±10 min. */
  possibleDuplicateOf?: string[];
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function group(reason: string): string {
  if (/no pudo extraer/.test(reason)) return "A";
  if (/subtotal de "Efectivo"/.test(reason)) return "C";
  if (/desproporcionado/.test(reason)) return "D";
  if (/el total \(/.test(reason)) return "E";
  return "F";
}

async function main(): Promise<void> {
  const tenantId = process.argv[2];
  if (!tenantId || tenantId.startsWith("--")) {
    console.error("uso: npm run reparse-failed-dry-run -- <tenantId> [--limit N] [--out <carpeta>]");
    process.exit(1);
  }
  const { tryBedrockVision } = await import("../src/parsing/bedrockVision.js");

  const limit = Number(arg("limit") ?? Infinity);
  const outDir = resolve(arg("out") ?? `../reparse-failed-${new Date().toISOString().slice(0, 10)}`);
  const outFile = join(outDir, "dry-run.json");
  mkdirSync(outDir, { recursive: true });

  // Al retomar se conservan solo las corridas buenas; los errores se reintentan.
  const previous: Entry[] = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : [];
  const entries = previous.filter((e) => e.outcome !== "error");
  const done = new Set(entries.map((e) => e.ticketId));
  if (previous.length > 0) {
    console.log(`Retomando: ${entries.length} ya procesados; se reintentan ${previous.length - entries.length} con error.`);
  }

  // Todos los tickets del tenant: candidatos (failed) y contados (para detectar duplicados).
  const candidates: Record<string, any>[] = [];
  const counted: Array<{ ticketId: string; at: number; total: number }> = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: TICKETS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
        ExpressionAttributeNames: { "#s": "status", "#t": "total" },
        ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":sk": "TICKET#" },
        ProjectionExpression: "pk, sk, ticketId, #s, capturedAt, failReason, rawKind, rawS3Key, #t",
        ExclusiveStartKey: startKey,
      }),
    );
    startKey = page.LastEvaluatedKey;
    for (const item of page.Items ?? []) {
      if (item.status === "failed") {
        if (/reporte de caja/.test(item.failReason ?? "")) continue;
        if (!done.has(item.ticketId)) candidates.push(item);
      } else if (["parsed", "needs_review"].includes(item.status) && typeof item.total === "number") {
        counted.push({ ticketId: item.ticketId, at: Date.parse(item.capturedAt), total: item.total });
      }
    }
  } while (startKey);

  const batch = candidates.slice(0, limit);
  console.log(`tenant ${tenantId}: ${candidates.length} fallido(s) por reprocesar (sin contar informes de caja).` + (batch.length < candidates.length ? ` Esta corrida: ${batch.length}.` : ""));

  let next = 0;
  let processed = 0;
  const save = () => writeFileSync(outFile, JSON.stringify(entries, null, 2));

  async function worker(): Promise<void> {
    while (next < batch.length) {
      const item = batch[next++];
      const base = { ticketId: item.ticketId, pk: item.pk, sk: item.sk, capturedAt: item.capturedAt, oldReason: item.failReason ?? "" };
      try {
        const object = await s3.send(new GetObjectCommand({ Bucket: RAW_BUCKET, Key: item.rawS3Key }));
        const bytes = Buffer.from((await object.Body?.transformToByteArray()) ?? new Uint8Array());
        if (item.rawKind !== "escpos" || !looksRasterDominant(readEscpos(bytes))) {
          entries.push({ ...base, outcome: "no-imagen" });
          continue;
        }
        const tiles = extractRasterTiles(bytes).map((tile) => tile.png);
        const result = await tryBedrockVision(tiles, MODEL_ID);
        if (result === null) {
          entries.push({ ...base, outcome: "sigue-fallando", newReason: "Bedrock vision no pudo extraer un ticket de la imagen" });
        } else if (isNotASale(result)) {
          entries.push({ ...base, outcome: "informe-de-caja" });
        } else {
          const coherence = checkEconomicCoherence(result);
          if (!coherence.ok) {
            entries.push({ ...base, outcome: "sigue-fallando", newReason: coherence.reason });
          } else {
            const at = Date.parse(item.capturedAt);
            const dups = counted
              .filter((c) => c.total === result.total && Math.abs(c.at - at) <= DUPLICATE_WINDOW_MS)
              .map((c) => c.ticketId);
            entries.push({ ...base, outcome: "recuperable", ticket: result, ...(dups.length ? { possibleDuplicateOf: dups } : {}) });
          }
        }
      } catch (err) {
        entries.push({ ...base, outcome: "error", newReason: err instanceof Error ? err.message : String(err) });
      }
      if (++processed % 10 === 0) {
        save();
        console.log(`  ${processed}/${batch.length}…`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  save();

  // Tabla para revisar.
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const header = "ticketId,fecha,grupo,resultado,total,items,medioPago,posibleDuplicado,motivoAntes,motivoAhora";
  const rows = [...entries]
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    .map((e) =>
      [
        e.ticketId.slice(0, 8),
        e.capturedAt.slice(0, 16),
        group(e.oldReason),
        e.outcome,
        e.ticket?.total ?? "",
        e.ticket?.items.length ?? "",
        e.ticket?.paymentMethod ?? "",
        e.possibleDuplicateOf ? e.possibleDuplicateOf.map((d) => d.slice(0, 8)).join(" ") : "",
        esc(e.oldReason.slice(0, 120)),
        esc((e.newReason ?? "").slice(0, 120)),
      ].join(","),
    );
  writeFileSync(join(outDir, "tabla.csv"), [header, ...rows].join("\n"));

  // Resumen.
  const byGroup = new Map<string, Map<string, number>>();
  for (const e of entries) {
    const g = group(e.oldReason);
    const m = byGroup.get(g) ?? new Map<string, number>();
    m.set(e.outcome, (m.get(e.outcome) ?? 0) + 1);
    byGroup.set(g, m);
  }
  console.log("\nResultado por grupo (A=no pudo extraer, C=cierre como ítems, D=IVA, E=total no cuadra, F=otro):");
  for (const [g, m] of [...byGroup].sort()) console.log(`  ${g}: ${[...m].map(([k, v]) => `${k}=${v}`).join("  ")}`);

  const recoverable = entries.filter((e) => e.outcome === "recuperable");
  const sum = recoverable.reduce((s, e) => s + (e.ticket?.total ?? 0), 0);
  const dups = recoverable.filter((e) => e.possibleDuplicateOf);
  console.log(`\nRecuperables: ${recoverable.length}, suman ${sum}. Posibles duplicados entre ellos: ${dups.length} (${dups.reduce((s, e) => s + (e.ticket?.total ?? 0), 0)}).`);
  console.log(`\nGuardado en ${outDir} (dry-run.json, tabla.csv). No se escribió nada en AWS.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
