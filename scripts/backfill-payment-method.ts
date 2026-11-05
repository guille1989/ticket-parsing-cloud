/*
 * Completa el medio de pago ("Medio de pago: QR / Efectivo…") en los tickets
 * ya guardados cuyo POS imprime la factura como IMAGEN (Loggro, Empanadas
 * Típicas). Relee el ticket crudo de S3, le pide a Bedrock vision SOLO esa
 * línea y escribe SOLO `paymentMethod` — no toca estado, ítems ni totales (a
 * diferencia de `reparse-ticket`, que vuelve a extraer todo y pisaría las
 * correcciones ya aplicadas).
 *
 * Cada UpdateItem dispara el Stream y el consumidor de analítica reescribe el
 * objeto de S3/Athena del ticket con el campo nuevo (no hace falta tocar S3).
 * Orden: primero desplegar el stack (columna de Athena + parser), después esto.
 *
 * Dos pasos, como en el reproceso OCR del 2026-10-16: Bedrock no es
 * determinista entre corridas, así que lo que se revisa es lo que se escribe.
 *   1) Corrida en seco (default): lee los tickets, llama a Bedrock y guarda el
 *      resultado en <out>/resultados.json. No escribe nada en AWS salvo leer.
 *      Se puede cortar y repetir: retoma los ticketId que ya están en el archivo.
 *   2) --apply --from <archivo>: escribe en DynamoDB lo que dice el archivo,
 *      sin volver a llamar a Bedrock. Solo donde el ticket todavía no tiene
 *      `paymentMethod` (no pisa nada) y solo los que se leyeron.
 *
 * Los tickets de texto (no imagen) se omiten: sus formatos no traen medio de pago.
 *
 * Uso:
 *   npm run backfill-payment-method -- <tenantId> [--limit N] [--out <carpeta>]
 *   npm run backfill-payment-method -- <tenantId> --apply --from <carpeta>/resultados.json
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { extractRasterTiles, looksRasterDominant, readEscpos } from "../src/parsing/escpos.js";

const REGION = "us-east-1";
// El cliente de Bedrock del módulo toma la región al importarse.
process.env.AWS_REGION ??= REGION;

const TICKETS_TABLE = process.env.TICKETS_TABLE ?? "TicketParsingCloudStack-TicketsTableB76A19AF-1RLLAB8N38KF6";
const RAW_BUCKET = process.env.RAW_BUCKET ?? "ticketparsingcloudstack-rawticketsbucket6ab163e9-gozelnd9h2h9";
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";
// La cuota de Bedrock es por cuenta: con 4 en paralelo ~1 de cada 4 lecturas agotaba los reintentos.
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY ?? 2);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });

interface Entry {
  ticketId: string;
  pk: string;
  sk: string;
  capturedAt: string;
  status: string;
  /** Texto tal como lo leyó el modelo; null = no hay medio de pago o no se leyó. */
  raw: string | null;
  /** Normalizado; ausente = no se escribe. */
  paymentMethod?: string;
  error?: string;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(): never {
  console.error(
    "uso:\n  npm run backfill-payment-method -- <tenantId> [--limit N] [--out <carpeta>]\n" +
      "  npm run backfill-payment-method -- <tenantId> --apply --from <carpeta>/resultados.json",
  );
  process.exit(1);
}

function summarize(entries: Entry[]): void {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.error ? "(error)" : (entry.paymentMethod ?? "(sin dato)");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  console.log("\nDistribución:");
  for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key.padEnd(14)} ${count}`);
  }
  const others = entries.filter((e) => e.paymentMethod === "Otro");
  if (others.length > 0) {
    console.log("\nTexto leído que no se reconoció (quedaría como 'Otro') — revisar:");
    for (const entry of others.slice(0, 20)) console.log(`  ${entry.ticketId}: "${entry.raw}"`);
  }
  const errors = entries.filter((e) => e.error);
  for (const entry of errors.slice(0, 10)) console.log(`  error ${entry.ticketId}: ${entry.error}`);
}

async function dryRun(tenantId: string): Promise<void> {
  const { tryBedrockPaymentMethod } = await import("../src/parsing/bedrockVision.js");

  const limit = Number(arg("limit") ?? Infinity);
  const outDir = resolve(arg("out") ?? `../backfill-payment-method-${new Date().toISOString().slice(0, 10)}`);
  const outFile = join(outDir, "resultados.json");
  mkdirSync(outDir, { recursive: true });

  // Al retomar se conservan solo las lecturas buenas: las que fallaron (p. ej.
  // por throttling de Bedrock) se vuelven a intentar.
  const previous: Entry[] = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : [];
  const entries = previous.filter((e) => !e.error);
  const done = new Set(entries.map((e) => e.ticketId));
  if (previous.length > 0) {
    console.log(`Retomando: ${entries.length} ticket(s) ya leídos en ${outFile}; se reintentan ${previous.length - entries.length} con error.`);
  }

  // 1) Candidatos: ventas de imagen todavía sin medio de pago.
  const candidates: Record<string, any>[] = [];
  let alreadyHave = 0;
  let notEscpos = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: TICKETS_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
        ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":sk": "TICKET#" },
        ExclusiveStartKey: startKey,
      }),
    );
    startKey = page.LastEvaluatedKey;
    for (const item of page.Items ?? []) {
      if (!["parsed", "needs_review"].includes(item.status)) continue;
      if (item.paymentMethod) {
        alreadyHave++;
        continue;
      }
      if (item.rawKind !== "escpos") {
        notEscpos++;
        continue;
      }
      if (!done.has(item.ticketId)) candidates.push(item);
    }
  } while (startKey);

  const batch = candidates.slice(0, limit);
  console.log(
    `tenant ${tenantId}: ${candidates.length} ticket(s) por leer (${alreadyHave} ya tienen medio de pago, ${notEscpos} no son ESC/POS).` +
      (batch.length < candidates.length ? ` Esta corrida: ${batch.length} (--limit).` : ""),
  );

  // 2) Lectura, con concurrencia baja (la cuota de Bedrock es por cuenta).
  let notImage = 0;
  let next = 0;
  let processed = 0;
  const save = () => writeFileSync(outFile, JSON.stringify(entries, null, 2));

  async function worker(): Promise<void> {
    while (next < batch.length) {
      const item = batch[next++];
      const base = { ticketId: item.ticketId, pk: item.pk, sk: item.sk, capturedAt: item.capturedAt, status: item.status };
      try {
        const object = await s3.send(new GetObjectCommand({ Bucket: RAW_BUCKET, Key: item.rawS3Key }));
        const bytes = Buffer.from((await object.Body?.transformToByteArray()) ?? new Uint8Array());
        if (!looksRasterDominant(readEscpos(bytes))) {
          notImage++;
          continue;
        }
        const tiles = extractRasterTiles(bytes).map((tile) => tile.png);
        const result = await tryBedrockPaymentMethod(tiles, MODEL_ID);
        entries.push({ ...base, raw: result.raw, ...(result.paymentMethod ? { paymentMethod: result.paymentMethod } : {}) });
      } catch (err) {
        entries.push({ ...base, raw: null, error: err instanceof Error ? err.message : String(err) });
      }
      if (++processed % 25 === 0) {
        save();
        console.log(`  ${processed}/${batch.length}…`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  save();

  console.log(`\nLeídos esta corrida: ${processed}. Omitidos por ser texto (no imagen): ${notImage}.`);
  summarize(entries);
  console.log(`\nResultado guardado en ${outFile}`);
  console.log("Corrida en seco: no se escribió nada en DynamoDB. Revisar y repetir con --apply --from <archivo>.");
}

async function apply(tenantId: string, file: string): Promise<void> {
  const entries: Entry[] = JSON.parse(readFileSync(resolve(file), "utf8"));
  const toWrite = entries.filter((e) => e.paymentMethod && !e.error);
  console.log(`Aplicando ${toWrite.length} de ${entries.length} (los demás no tienen medio de pago leído).`);

  const log: Array<{ ticketId: string; outcome: "escrito" | "ya-tenia" | "error"; detail?: string }> = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < toWrite.length) {
      const entry = toWrite[next++];
      if (entry.pk !== `TENANT#${tenantId}`) {
        log.push({ ticketId: entry.ticketId, outcome: "error", detail: "el ticket no es de este tenant" });
        continue;
      }
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: TICKETS_TABLE,
            Key: { pk: entry.pk, sk: entry.sk },
            UpdateExpression: "SET paymentMethod = :pm",
            // No pisa un valor existente ni crea un ticket que ya no está.
            ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(paymentMethod)",
            ExpressionAttributeValues: { ":pm": entry.paymentMethod },
          }),
        );
        log.push({ ticketId: entry.ticketId, outcome: "escrito" });
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.push({ ticketId: entry.ticketId, outcome: "ya-tenia" });
        } else {
          log.push({ ticketId: entry.ticketId, outcome: "error", detail: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const logFile = join(dirname(resolve(file)), "log-aplicar.json");
  writeFileSync(logFile, JSON.stringify(log, null, 2));
  const count = (outcome: string) => log.filter((l) => l.outcome === outcome).length;
  console.log(`Escritos: ${count("escrito")}. Ya tenían valor (no se tocaron): ${count("ya-tenia")}. Errores: ${count("error")}.`);
  console.log(`Log en ${logFile}`);
}

async function main(): Promise<void> {
  const tenantId = process.argv[2];
  if (!tenantId || tenantId.startsWith("--")) usage();

  if (process.argv.includes("--apply")) {
    const from = arg("from");
    if (!from) usage();
    await apply(tenantId, from);
  } else {
    await dryRun(tenantId);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
