// Script administrativo — lista todos los tenants dados de alta (manual con
// onboard-tenant.ts o self-service con POST /signup): negocio, email, fecha
// de alta, cuántos de sus 5 códigos de robot ya se usaron, y si está
// bloqueado. Un Scan completo de la tabla — aceptable acá porque es un
// tenant table chico y esto se corre a mano, no en un hot path.
//
// Uso:
//   TENANTS_TABLE=... ACTIVATION_CODES_TABLE=... USER_POOL_ID=... \
//     npx tsx scripts/list-tenants.ts
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import { findTenantUsers } from "./lib/findTenantUsers.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`falta la variable de entorno ${name}`);
  }
  return value;
}

interface TenantRow {
  tenantId: string;
  businessName: string;
  createdAt: string;
  status?: string;
}

async function main(): Promise<void> {
  const tenantsTable = requireEnv("TENANTS_TABLE");
  const activationCodesTable = requireEnv("ACTIVATION_CODES_TABLE");
  const userPoolId = requireEnv("USER_POOL_ID");

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const cognito = new CognitoIdentityProviderClient({});

  const scan = await ddb.send(new ScanCommand({ TableName: tenantsTable }));
  const tenants = (scan.Items ?? []) as TenantRow[];
  tenants.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (tenants.length === 0) {
    console.log("No hay tenants dados de alta.");
    return;
  }

  for (const tenant of tenants) {
    const codes = await ddb.send(
      new QueryCommand({
        TableName: activationCodesTable,
        IndexName: "tenantId-index",
        KeyConditionExpression: "tenantId = :t",
        ExpressionAttributeValues: { ":t": tenant.tenantId },
      }),
    );
    const codeItems = (codes.Items ?? []) as Array<{ status: string }>;
    const used = codeItems.filter((c) => c.status === "used").length;

    const users = await findTenantUsers(cognito, userPoolId, tenant.tenantId);
    const email = users[0]?.Attributes?.find((a) => a.Name === "email")?.Value ?? "(sin usuario Cognito)";

    const status = tenant.status ?? "active";
    console.log(`[${status === "blocked" ? "BLOQUEADO" : "activo"}] ${tenant.businessName}`);
    console.log(`  tenantId: ${tenant.tenantId}`);
    console.log(`  email:    ${email}`);
    console.log(`  alta:     ${tenant.createdAt}`);
    console.log(`  robots:   ${used}/${codeItems.length} códigos usados`);
    console.log("");
  }

  console.log(`Total: ${tenants.length} tenant(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
