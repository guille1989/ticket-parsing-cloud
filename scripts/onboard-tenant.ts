// Script administrativo — se corre a mano (con credenciales AWS reales)
// cada vez que se suma un negocio nuevo. No se despliega, no es parte del
// stack: crea la API key en API Gateway, la asocia al usage plan, y da de
// alta el registro del tenant en DynamoDB.
//
// Uso:
//   TICKET_STACK_USAGE_PLAN_ID=... TENANTS_TABLE=... \
//     npx tsx scripts/onboard-tenant.ts --business "La Esquina del Sabor" --parser example-38col
import { randomUUID } from "node:crypto";

import { APIGatewayClient, CreateApiKeyCommand, CreateUsagePlanKeyCommand } from "@aws-sdk/client-api-gateway";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

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
  const businessName = requireArg("business");
  const parserId = requireArg("parser");
  const usagePlanId = requireEnv("TICKET_STACK_USAGE_PLAN_ID");
  const tenantsTable = requireEnv("TENANTS_TABLE");

  const apigw = new APIGatewayClient({});
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  const tenantId = randomUUID();

  const apiKey = await apigw.send(
    new CreateApiKeyCommand({ name: `tenant-${tenantId}`, enabled: true, generateDistinctId: true }),
  );
  if (!apiKey.id || !apiKey.value) {
    throw new Error("no se pudo crear la API key");
  }

  await apigw.send(new CreateUsagePlanKeyCommand({ usagePlanId, keyId: apiKey.id, keyType: "API_KEY" }));

  await ddb.send(
    new PutCommand({
      TableName: tenantsTable,
      Item: {
        pk: `TENANT#${tenantId}`,
        tenantId,
        businessName,
        parserId,
        // Vacío al crear — se completa después con assign-port-parser.ts
        // a medida que el negocio suma periféricos con formatos propios
        // (ej. un datáfono además de la impresora).
        portParsers: {},
        apiKeyId: apiKey.id,
        createdAt: new Date().toISOString(),
      },
    }),
  );

  console.log("Tenant creado:");
  console.log(`  tenantId:    ${tenantId}`);
  console.log(`  negocio:     ${businessName}`);
  console.log(`  parser:      ${parserId}`);
  console.log(`  API key:     ${apiKey.value}`);
  console.log("\nEsta API key va en la config del print-capture-agent de ese negocio (CLOUD_API_KEY).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
