// Script administrativo — asigna (o reemplaza) el parser de un puerto
// puntual para un tenant que ya existe (ej. un negocio que suma un
// datáfono además de la impresora, cada uno con su propio formato).
//
// Uso:
//   TENANTS_TABLE=... npx tsx scripts/assign-port-parser.ts \
//     --tenant <tenantId> --port COM7 --parser ingenico-v1
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

function requireArg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    throw new Error(`falta --${name}`);
  }
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`falta la variable de entorno ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const tenantId = requireArg("tenant");
  const port = requireArg("port");
  const parserId = requireArg("parser");
  const tenantsTable = requireEnv("TENANTS_TABLE");

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  await ddb.send(
    new UpdateCommand({
      TableName: tenantsTable,
      Key: { pk: `TENANT#${tenantId}` },
      UpdateExpression: "SET portParsers.#port = :parserId",
      ExpressionAttributeNames: { "#port": port },
      ExpressionAttributeValues: { ":parserId": parserId },
    }),
  );

  console.log(`Listo: puerto ${port} del tenant ${tenantId} ahora usa el parser "${parserId}".`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
