/*
 * Completa en los tickets de facturas electrónicas (rawKind "ubl") ya guardados
 * los datos que el parser empezó a extraer después: tipo de documento,
 * cliente, orden de compra y vencimiento del pago. Relee el XML original de S3
 * y SOLO escribe esos campos — no toca el estado, los ítems ni los totales.
 *
 * Cada UpdateItem dispara el Stream, y el consumidor de analítica reescribe el
 * objeto de S3/Athena del ticket con los campos nuevos (no hace falta tocar S3).
 * Orden: primero desplegar el stack (columnas de Athena + parser), después esto.
 *
 * Por defecto es una corrida en seco: solo cuenta y muestra qué cambiaría.
 *
 * Uso:
 *   npm run backfill-ubl-fields -- <tenantId>            # en seco
 *   npm run backfill-ubl-fields -- <tenantId> --apply    # escribe
 */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { decodeXmlBytes, parseUblInvoice } from "../src/parsing/ubl.js";

const REGION = "us-east-1";
const TICKETS_TABLE = process.env.TICKETS_TABLE ?? "TicketParsingCloudStack-TicketsTableB76A19AF-1RLLAB8N38KF6";
const RAW_BUCKET = process.env.RAW_BUCKET ?? "ticketparsingcloudstack-rawticketsbucket6ab163e9-gozelnd9h2h9";

const FIELDS = ["docType", "customerName", "customerId", "purchaseOrder", "paymentDueDate"] as const;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });

async function main(): Promise<void> {
  const tenantId = process.argv[2];
  const apply = process.argv.includes("--apply");
  if (!tenantId || tenantId.startsWith("--")) {
    console.error("uso: npm run backfill-ubl-fields -- <tenantId> [--apply]");
    process.exit(1);
  }

  let scanned = 0;
  let unchanged = 0;
  let toUpdate = 0;
  let skipped = 0;
  let written = 0;
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
      if (item.rawKind !== "ubl" || !["parsed", "needs_review"].includes(item.status)) continue;
      scanned++;

      const object = await s3.send(new GetObjectCommand({ Bucket: RAW_BUCKET, Key: item.rawS3Key }));
      const bytes = Buffer.from((await object.Body?.transformToByteArray()) ?? new Uint8Array());
      const result = parseUblInvoice(decodeXmlBytes(bytes));
      if (result.kind !== "sale") {
        skipped++;
        console.warn(`  omitido ${item.ticketId} (${item.documentNumber ?? "?"}): ya no se lee como venta — ${"reason" in result ? result.reason : ""}`);
        continue;
      }

      const wanted: Record<string, string> = {};
      for (const field of FIELDS) {
        const value = result.ticket[field];
        if (value !== undefined && item[field] !== value) wanted[field] = value;
      }
      if (Object.keys(wanted).length === 0) {
        unchanged++;
        continue;
      }
      toUpdate++;
      if (toUpdate <= 5) console.log(`  ${item.documentNumber ?? item.ticketId}: ${JSON.stringify(wanted)}`);

      if (apply) {
        const names = Object.keys(wanted);
        await ddb.send(
          new UpdateCommand({
            TableName: TICKETS_TABLE,
            Key: { pk: item.pk, sk: item.sk },
            UpdateExpression: "SET " + names.map((n) => `${n} = :${n}`).join(", "),
            ExpressionAttributeValues: Object.fromEntries(names.map((n) => [`:${n}`, wanted[n]])),
            ConditionExpression: "attribute_exists(pk)",
          }),
        );
        written++;
      }
    }
  } while (startKey);

  console.log(
    `\ntenant ${tenantId}: ${scanned} factura(s) revisadas — ${toUpdate} por completar, ${unchanged} ya al día, ${skipped} omitidas.`,
  );
  console.log(apply ? `Escritas: ${written}.` : "Corrida en seco: no se escribió nada. Repetir con --apply.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
