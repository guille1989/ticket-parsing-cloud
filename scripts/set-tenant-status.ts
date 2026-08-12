// Script administrativo — bloquea o desbloquea un tenant. Bloqueado corta
// el acceso en los dos lugares que importan (ver TenantRecord.status en
// shared/types.ts): el login del dashboard (Cognito Pre-Authentication
// trigger, tenants/preAuthHandler.ts) y la subida de tickets del agente
// (ingest/handler.ts).
//
// Al bloquear, además se cierra cualquier sesión ya abierta con
// AdminUserGlobalSignOut — el trigger de Cognito no corre en
// REFRESH_TOKEN_AUTH, así que alguien ya logueado seguiría refrescando su
// sesión sola hasta que expire el refresh token (30 días por default) si
// no se hace esto.
//
// Uso:
//   TENANTS_TABLE=... USER_POOL_ID=... npx tsx scripts/set-tenant-status.ts \
//     --tenant <tenantId> --status blocked
//   TENANTS_TABLE=... USER_POOL_ID=... npx tsx scripts/set-tenant-status.ts \
//     --tenant <tenantId> --status active
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { findTenantUsers } from "./lib/findTenantUsers.js";

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
  const status = requireArg("status");
  if (status !== "active" && status !== "blocked") {
    throw new Error('--status debe ser "active" o "blocked"');
  }

  const tenantsTable = requireEnv("TENANTS_TABLE");
  const userPoolId = requireEnv("USER_POOL_ID");

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const cognito = new CognitoIdentityProviderClient({});

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tenantsTable,
        Key: { pk: `TENANT#${tenantId}` },
        UpdateExpression: "SET #status = :status",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":status": status },
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new Error(`no existe ningún tenant con id ${tenantId}`);
    }
    throw err;
  }

  if (status === "blocked") {
    const users = await findTenantUsers(cognito, userPoolId, tenantId);
    for (const user of users) {
      if (!user.Username) continue;
      await cognito.send(new AdminUserGlobalSignOutCommand({ UserPoolId: userPoolId, Username: user.Username }));
      console.log(`Sesión activa cerrada para ${user.Username}.`);
    }
  }

  console.log(`Tenant ${tenantId} ahora está "${status}".`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
