/*
 * Etapa A del roadmap OCR — prueba Fases 1-3 de punta a punta EN LA NUBE,
 * sin el agente y sin tocar la PC de Empanadas.
 *
 * Sube el .escpos real de Loggro (fixtures/escpos/loggro-factura-raster.escpos,
 * = el job2.bin capturado el 2026-09-09) al endpoint POST /tickets con la
 * api-key del agente de Empanadas, y muestra cómo quedó el ticket en
 * DynamoDB después del OCR con Bedrock vision.
 *
 * Requiere: credenciales AWS de la cuenta 724064282801, y haber corrido
 * `npx cdk deploy` antes.
 *
 * Uso:  npm run etapa-a-ocr
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { APIGatewayClient, GetApiKeyCommand } from "@aws-sdk/client-api-gateway";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const REGION = "us-east-1";
const API = "https://uqa4ti7fwi.execute-api.us-east-1.amazonaws.com/prod/tickets";
const AGENT_API_KEY_ID = "m8v0h3tm1i"; // agente "Santiago_01_ca" de Empanadas Típicas
const TENANT_ID = "de728d42-eb0b-43e4-ba15-16c10962c719";
const TICKETS_TABLE = "TicketParsingCloudStack-TicketsTableB76A19AF-1RLLAB8N38KF6";
const PRINTER = "EPSON TM-T20II Receipt";
const ESCPOS_FILE = join(process.cwd(), "fixtures", "escpos", "loggro-factura-raster.escpos");

const apigw = new APIGatewayClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

async function main(): Promise<void> {
  const bytes = readFileSync(ESCPOS_FILE);
  console.log(`escpos: ${ESCPOS_FILE} — ${bytes.length} bytes`);

  console.log("\n== 1. api-key del agente ==");
  const { value: apiKey } = await apigw.send(new GetApiKeyCommand({ apiKey: AGENT_API_KEY_ID, includeValue: true }));
  if (!apiKey) throw new Error(`no se pudo obtener el valor de la api-key ${AGENT_API_KEY_ID}`);
  console.log(`   ok (...${apiKey.slice(-4)})`);

  const ticketId = randomUUID();
  const capturedAt = new Date().toISOString();
  const payload = { ticketId, port: PRINTER, capturedAt, rawEncoding: "escpos", rawBase64: bytes.toString("base64") };

  console.log("\n== 2. POST /tickets ==");
  console.log(`   ticketId=${ticketId}  base64=${payload.rawBase64.length} chars`);
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  console.log(`   HTTP ${res.status} -> ${body}`);
  if (res.status !== 202) throw new Error("esperaba 202");

  console.log("\n== 3. esperando el OCR (Bedrock vision puede tardar 10-40s) ==");
  const sk = `TICKET#${capturedAt}#${ticketId}`;
  for (let i = 1; i <= 25; i++) {
    await sleep(6000);
    const { Item } = await ddb.send(
      new GetCommand({ TableName: TICKETS_TABLE, Key: { pk: `TENANT#${TENANT_ID}`, sk } }),
    );
    const status = Item?.status as string | undefined;
    console.log(`   [${i * 6}s] status = ${status ?? "(todavía no aparece)"}`);
    if (status && status !== "pending") {
      console.log("\n== 4. resultado ==");
      console.log(JSON.stringify({
        status: Item!.status,
        rawKind: Item!.rawKind,
        parsedBy: Item!.parsedBy,
        total: Item!.total,
        discount: Item!.discount,
        tip: Item!.tip,
        items: Item!.items,
        failReason: Item!.failReason,
        rawS3Key: Item!.rawS3Key,
      }, null, 2));
      return;
    }
  }
  throw new Error("se agotó la espera — revisá los logs de ParserFunction en CloudWatch");
}

main().catch((err) => {
  console.error("\nERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
