/*
 * Aplica el resultado de `reparse-failed-dry-run`: pasa a `needs_review` los
 * tickets `failed` que la corrida en seco marcó como `recuperable`, escribiendo
 * EXACTAMENTE lo que ya se revisó en dry-run.json (no vuelve a llamar a Bedrock,
 * que no es determinista). Cada UpdateItem dispara el Stream y el consumidor de
 * analítica escribe la fila de S3/Athena del ticket.
 *
 * Qué escribe por ticket (lo mismo que `markParsed` del parser, más quitar el
 * motivo de fallo viejo, que la app no borra y `/read` devuelve):
 *   status = needs_review (todo lo que resuelve un LLM queda en revisión),
 *   parsedAt, items, total, tax, discount, tip, parsedBy = bedrock-vision,
 *   gsi1pk/gsi1sk del nuevo estado, los campos opcionales (paymentMethod) y
 *   REMOVE failReason.
 *
 * Seguridad:
 *   - Solo escribe si el ticket SIGUE en `failed` (ConditionExpression). Si
 *     alguien lo descartó o ya lo recuperó, no se toca.
 *   - Se omiten los `possibleDuplicateOf` (podrían contar la venta dos veces).
 *   - Solo `outcome === "recuperable"`; informes de caja y errores nunca.
 *   - Sin --apply es un plan: lista lo que haría y no escribe nada.
 *
 * Orden: el stack ya debe estar desplegado (AnalyticsSync con paymentMethod).
 *
 * Uso:
 *   npm run reparse-failed-apply -- <tenantId> --from <carpeta>/dry-run.json            # plan
 *   npm run reparse-failed-apply -- <tenantId> --from <carpeta>/dry-run.json --apply    # escribe
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import type { ParsedTicket } from "../src/parsing/types.js";
import { ticketStatusGsiKey } from "../src/shared/dynamo.js";

const REGION = "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE ?? "TicketParsingCloudStack-TicketsTableB76A19AF-1RLLAB8N38KF6";
const CONCURRENCY = 2;

/** Mismos campos opcionales que `OPTIONAL_STRING_FIELDS` de parser/handler.ts. */
const OPTIONAL_STRING_FIELDS = ["documentNumber", "docType", "customerName", "customerId", "purchaseOrder", "paymentDueDate", "paymentMethod"] as const;

interface Entry {
  ticketId: string;
  pk: string;
  sk: string;
  capturedAt: string;
  outcome: string;
  ticket?: ParsedTicket;
  possibleDuplicateOf?: string[];
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function buildUpdate(tenantId: string, entry: Entry & { ticket: ParsedTicket }): UpdateCommand {
  const parsed = entry.ticket;
  const optional = OPTIONAL_STRING_FIELDS.filter((field) => parsed[field] !== undefined);
  return new UpdateCommand({
    TableName: TICKETS_TABLE,
    Key: { pk: entry.pk, sk: entry.sk },
    UpdateExpression:
      "SET #status = :status, parsedAt = :parsedAt, #items = :items, #total = :total, #tax = :tax, discount = :discount, tip = :tip, parsedBy = :parsedBy, gsi1pk = :gsi1pk, gsi1sk = :gsi1sk" +
      optional.map((field) => `, ${field} = :${field}`).join("") +
      " REMOVE failReason",
    // Solo si sigue fallido: no pisa un ticket que alguien descartó o ya recuperó.
    ConditionExpression: "attribute_exists(pk) AND #status = :failed",
    ExpressionAttributeNames: { "#status": "status", "#total": "total", "#items": "items", "#tax": "tax" },
    ExpressionAttributeValues: {
      ":failed": "failed",
      ":status": "needs_review",
      ":parsedAt": new Date().toISOString(),
      ":items": parsed.items,
      ":total": parsed.total,
      ":tax": parsed.tax ?? null,
      ":discount": parsed.discount ?? null,
      ":tip": parsed.tip ?? null,
      ":parsedBy": "bedrock-vision",
      ...Object.fromEntries(optional.map((field) => [`:${field}`, parsed[field]])),
      ":gsi1pk": ticketStatusGsiKey(tenantId, "needs_review", entry.capturedAt).gsi1pk,
      ":gsi1sk": ticketStatusGsiKey(tenantId, "needs_review", entry.capturedAt).gsi1sk,
    },
  });
}

async function main(): Promise<void> {
  const tenantId = process.argv[2];
  const from = arg("from");
  if (!tenantId || tenantId.startsWith("--") || !from) {
    console.error("uso: npm run reparse-failed-apply -- <tenantId> --from <carpeta>/dry-run.json [--apply]");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");

  const all: Entry[] = JSON.parse(readFileSync(resolve(from), "utf8"));
  const recoverable = all.filter((e): e is Entry & { ticket: ParsedTicket } => e.outcome === "recuperable" && !!e.ticket);
  const duplicates = recoverable.filter((e) => e.possibleDuplicateOf && e.possibleDuplicateOf.length > 0);
  const toWrite = recoverable.filter((e) => !duplicates.includes(e) && e.pk === `TENANT#${tenantId}`);
  const otherTenant = recoverable.length - duplicates.length - toWrite.length;
  if (otherTenant > 0) throw new Error(`${otherTenant} ticket(s) del archivo no son del tenant ${tenantId}; se aborta`);

  const sum = toWrite.reduce((s, e) => s + e.ticket.total, 0);
  console.log(
    `Archivo: ${all.length} entradas, ${recoverable.length} recuperables. A escribir: ${toWrite.length} (suman ${sum}). ` +
      `Omitidos por posible duplicado: ${duplicates.length}.`,
  );

  if (!apply) {
    for (const e of toWrite.slice(0, 5)) {
      console.log(`  ${e.ticketId.slice(0, 8)} ${e.capturedAt.slice(0, 16)} total ${e.ticket.total}, ${e.ticket.items.length} ítem(s), ${e.ticket.paymentMethod ?? "sin medio de pago"} → needs_review`);
    }
    if (toWrite.length > 5) console.log(`  … y ${toWrite.length - 5} más`);
    console.log("Plan: no se escribió nada. Repetir con --apply.");
    return;
  }

  const log: Array<{ ticketId: string; outcome: "escrito" | "ya-no-estaba-failed" | "error"; detail?: string }> = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < toWrite.length) {
      const entry = toWrite[next++];
      try {
        await ddb.send(buildUpdate(tenantId, entry));
        log.push({ ticketId: entry.ticketId, outcome: "escrito" });
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.push({ ticketId: entry.ticketId, outcome: "ya-no-estaba-failed" });
        } else {
          log.push({ ticketId: entry.ticketId, outcome: "error", detail: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const logFile = join(dirname(resolve(from)), "log-aplicar.json");
  writeFileSync(logFile, JSON.stringify(log, null, 2));
  const count = (outcome: string) => log.filter((l) => l.outcome === outcome).length;
  console.log(`Escritos: ${count("escrito")}. Ya no estaban en failed (no se tocaron): ${count("ya-no-estaba-failed")}. Errores: ${count("error")}.`);
  console.log(`Log en ${logFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
