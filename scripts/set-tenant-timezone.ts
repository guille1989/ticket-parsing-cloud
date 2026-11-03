// Script administrativo — fija la zona horaria de un negocio (`advisor.timeZone` en la tabla
// Tenants). Advisor la necesita para saber cuándo son las 07:00 de cada negocio y qué día es
// "ayer": hasta ahora la zona solo la mandaba el navegador, y el job corre sin navegador.
// Sin esto Advisor usa America/Bogota para todos.
//
// Por defecto solo muestra qué haría; con --apply escribe.
//
// Uso (desde ticket-parsing-cloud/):
//   npm run set-tenant-timezone -- --tenant <tenantId> --timezone America/Bogota
//   npm run set-tenant-timezone -- --tenant <tenantId> --timezone Europe/Madrid --apply
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { isValidTimeZone } from "../src/widgets/fields.js";
import { readStackOutputs, requireOutput } from "./lib/stackOutputs.js";

function requireArg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`falta --${name}`);
  return value;
}

async function main(): Promise<void> {
  const tenantId = requireArg("tenant");
  const timeZone = requireArg("timezone");
  const apply = process.argv.includes("--apply");
  if (!isValidTimeZone(timeZone)) throw new Error(`zona horaria inválida: "${timeZone}" (se espera un nombre IANA, ej. America/Bogota)`);

  const tenantsTable = requireOutput(readStackOutputs(), "TenantsTableName");
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
  const key = { pk: `TENANT#${tenantId}` };

  const { Item } = await ddb.send(new GetCommand({ TableName: tenantsTable, Key: key, ConsistentRead: true }));
  if (!Item) throw new Error(`no existe ningún tenant con id ${tenantId}`);

  const current = (Item.advisor ?? {}) as Record<string, unknown>;
  // `advisor` es un mapa con más ajustes (hora del briefing, correos): se conserva lo que ya tenga.
  const next = { ...current, timeZone };
  console.log(`${Item.businessName} (${tenantId})`);
  console.log(`  zona actual: ${current.timeZone ?? "(sin definir, Advisor usa America/Bogota)"}`);
  console.log(`  zona nueva:  ${timeZone}`);
  if (current.timeZone === timeZone) {
    console.log("  ya está así, nada que hacer.");
    return;
  }
  if (!apply) {
    console.log("  (corrida en seco: agregá --apply para escribir)");
    return;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: tenantsTable,
      Key: key,
      UpdateExpression: "SET advisor = :advisor",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":advisor": next },
    }),
  );
  console.log("  listo.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
