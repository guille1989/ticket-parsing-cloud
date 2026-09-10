/*
 * Lista los tickets más recientes de un tenant, directo de DynamoDB.
 * Para chequear resultados durante las pruebas del piloto sin pasar por el
 * dashboard (que necesita login de Cognito).
 *
 * Uso:
 *   npm run tenant-tickets -- <tenantId> [cantidad]
 *   npm run tenant-tickets                 # default: tenant de Empanadas, 10
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const REGION = "us-east-1";
const TICKETS_TABLE = "TicketParsingCloudStack-TicketsTableB76A19AF-1RLLAB8N38KF6";
const DEFAULT_TENANT = "de728d42-eb0b-43e4-ba15-16c10962c719"; // Empanadas Típicas / santiago_test

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

async function main(): Promise<void> {
  const tenantId = process.argv[2] || DEFAULT_TENANT;
  const limit = Number(process.argv[3] || 10);

  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: TICKETS_TABLE,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
      ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}`, ":sk": "TICKET#" },
      ScanIndexForward: false, // más recientes primero
      Limit: limit,
    }),
  );

  console.log(`tenant ${tenantId} — ${Items.length} ticket(s) más recientes:\n`);
  for (const t of Items) {
    console.log(`${t.capturedAt}  ${t.status.padEnd(13)} ${(t.rawKind ?? "text").padEnd(7)} ${t.parsedBy ?? "-"}`);
    console.log(`  port: ${t.port}   ticketId: ${t.ticketId}`);
    if (t.status === "parsed" || t.status === "needs_review") {
      const extra = [t.tax != null ? `tax: ${t.tax}` : "", t.discount != null ? `desc: ${t.discount}` : "", t.tip != null ? `prop: ${t.tip}` : ""]
        .filter(Boolean).join("  ");
      console.log(`  total: ${t.total}${extra ? "   " + extra : ""}`);
      console.log(`  items: ${JSON.stringify(t.items)}`);
    }
    if (t.failReason) console.log(`  failReason: ${t.failReason}`);
    console.log();
  }
}

main().catch((err) => {
  console.error("ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
