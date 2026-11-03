// Script administrativo — enciende o apaga la vista beta del asistente (Innova) para un negocio
// (`advisor.betaView` en la tabla Tenants). Apagada es lo normal: el negocio ve el dashboard de
// siempre. Encendida, su dashboard muestra la pestaña nueva. Se conservan los demás ajustes del
// asesor (zona horaria, hora del briefing, correos).
//
// Por defecto solo muestra qué haría; con --apply escribe.
//
// Uso (desde ticket-parsing-cloud/):
//   npm run set-tenant-advisor-view -- --tenant <tenantId> --on
//   npm run set-tenant-advisor-view -- --tenant <tenantId> --on --apply
//   npm run set-tenant-advisor-view -- --tenant <tenantId> --off --apply
//   npm run set-tenant-advisor-view -- --list        # qué negocios la tienen encendida
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { readStackOutputs, requireOutput } from "./lib/stackOutputs.js";

const has = (flag: string) => process.argv.includes(`--${flag}`);
function requireArg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`falta --${name}`);
  return value;
}

async function main(): Promise<void> {
  const tenantsTable = requireOutput(readStackOutputs(), "TenantsTableName");
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));

  if (has("list")) {
    const { Items = [] } = await ddb.send(new ScanCommand({ TableName: tenantsTable, ProjectionExpression: "tenantId, businessName, advisor" }));
    for (const item of Items) console.log(`${item.advisor?.betaView === true ? "ENCENDIDA" : "apagada  "}  ${item.businessName} (${item.tenantId})`);
    return;
  }

  if (has("on") === has("off")) throw new Error("indicá exactamente una de --on o --off");
  const betaView = has("on");
  const tenantId = requireArg("tenant");
  const key = { pk: `TENANT#${tenantId}` };

  const { Item } = await ddb.send(new GetCommand({ TableName: tenantsTable, Key: key, ConsistentRead: true }));
  if (!Item) throw new Error(`no existe ningún tenant con id ${tenantId}`);

  const current = (Item.advisor ?? {}) as Record<string, unknown>;
  console.log(`${Item.businessName} (${tenantId})`);
  console.log(`  vista beta ahora:   ${current.betaView === true ? "encendida" : "apagada"}`);
  console.log(`  vista beta después: ${betaView ? "encendida" : "apagada"}`);
  if ((current.betaView === true) === betaView) {
    console.log("  ya está así, nada que hacer.");
    return;
  }
  if (!has("apply")) {
    console.log("  (corrida en seco: agregá --apply para escribir)");
    return;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: tenantsTable,
      Key: key,
      UpdateExpression: "SET advisor = :advisor",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":advisor": { ...current, betaView } },
    }),
  );
  console.log("  listo.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
