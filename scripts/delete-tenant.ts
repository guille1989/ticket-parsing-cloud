// Script administrativo — borra un tenant por completo: usuario(s) de
// Cognito, api-keys de API Gateway (la de cada agente + la legacy
// compartida si tiene), todos sus tickets/widgets/agentes/códigos de
// activación en DynamoDB, y sus objetos en S3 (raw tickets + filas de
// analítica). IRREVERSIBLE — por eso exige --confirm explícito.
//
// Uso:
//   TENANTS_TABLE=... TICKETS_TABLE=... WIDGETS_TABLE=... AGENTS_TABLE=... \
//   ACTIVATION_CODES_TABLE=... USER_POOL_ID=... RAW_BUCKET=... ANALYTICS_BUCKET=... \
//     npx tsx scripts/delete-tenant.ts --tenant <tenantId> --confirm
import { APIGatewayClient, DeleteApiKeyCommand } from "@aws-sdk/client-api-gateway";
import { AdminDeleteUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { findTenantUsers } from "./lib/findTenantUsers.js";

function requireArg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    throw new Error(`falta --${name}`);
  }
  return value;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`falta la variable de entorno ${name}`);
  }
  return value;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});
const apigw = new APIGatewayClient({});
const s3 = new S3Client({});

/** Borra todos los items de una tabla con PK = `TENANT#<id>` (Tickets/Widgets/Agents), en lotes de 25. */
async function deleteAllByTenantPk(tableName: string, tenantId: string): Promise<number> {
  let count = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}` },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const items = (result.Items ?? []) as Array<{ pk: string; sk: string }>;
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      await ddb.send(
        new BatchWriteCommand({
          RequestItems: { [tableName]: batch.map((item) => ({ DeleteRequest: { Key: { pk: item.pk, sk: item.sk } } })) },
        }),
      );
    }
    count += items.length;
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return count;
}

/** ActivationCodes no está anidada bajo el tenant (PK = CODE#<code>) — se resuelve por el GSI. */
async function deleteActivationCodes(tableName: string, tenantId: string): Promise<number> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: "tenantId-index",
      KeyConditionExpression: "tenantId = :t",
      ExpressionAttributeValues: { ":t": tenantId },
    }),
  );
  const codes = (result.Items ?? []) as Array<{ pk: string }>;
  for (let i = 0; i < codes.length; i += 25) {
    const batch = codes.slice(i, i + 25);
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: { [tableName]: batch.map((item) => ({ DeleteRequest: { Key: { pk: item.pk } } })) },
      }),
    );
  }
  return codes.length;
}

/** Borra todo lo que haya bajo un prefijo de S3, paginando de a 1000 (límite de DeleteObjects). */
async function deletePrefix(bucket: string, prefix: string): Promise<number> {
  let count = 0;
  let continuationToken: string | undefined;
  do {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }));
    const keys = (listed.Contents ?? []).map((obj) => obj.Key).filter((key): key is string => !!key);
    if (keys.length > 0) {
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
      count += keys.length;
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
  return count;
}

async function main(): Promise<void> {
  const tenantId = requireArg("tenant");
  if (!hasFlag("confirm")) {
    throw new Error("esto borra TODO el tenant sin vuelta atrás — volvé a correrlo con --confirm si estás seguro");
  }

  const tenantsTable = requireEnv("TENANTS_TABLE");
  const ticketsTable = requireEnv("TICKETS_TABLE");
  const widgetsTable = requireEnv("WIDGETS_TABLE");
  const agentsTable = requireEnv("AGENTS_TABLE");
  const activationCodesTable = requireEnv("ACTIVATION_CODES_TABLE");
  const userPoolId = requireEnv("USER_POOL_ID");
  const rawBucket = requireEnv("RAW_BUCKET");
  const analyticsBucket = requireEnv("ANALYTICS_BUCKET");

  const tenantResult = await ddb.send(new GetCommand({ TableName: tenantsTable, Key: { pk: `TENANT#${tenantId}` } }));
  const tenant = tenantResult.Item as { tenantId: string; businessName: string; apiKeyId?: string } | undefined;
  if (!tenant) {
    throw new Error(`no existe ningún tenant con id ${tenantId}`);
  }
  console.log(`Borrando "${tenant.businessName}" (${tenantId})...`);

  // Agentes primero: hace falta leerlos ANTES de borrarlos para saber qué
  // api-keys de API Gateway hay que borrar también (una por robot).
  const agentsResult = await ddb.send(
    new QueryCommand({ TableName: agentsTable, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}` } }),
  );
  const agents = (agentsResult.Items ?? []) as Array<{ apiKeyId?: string; name?: string }>;
  for (const agent of agents) {
    if (agent.apiKeyId) {
      await apigw.send(new DeleteApiKeyCommand({ apiKey: agent.apiKeyId })).catch((err) => {
        console.error(`  no se pudo borrar la api-key del agente "${agent.name}" (${agent.apiKeyId}):`, err.message ?? err);
      });
    }
  }
  if (tenant.apiKeyId) {
    await apigw.send(new DeleteApiKeyCommand({ apiKey: tenant.apiKeyId })).catch((err) => {
      console.error(`  no se pudo borrar la api-key legacy del tenant (${tenant.apiKeyId}):`, err.message ?? err);
    });
  }

  const ticketsDeleted = await deleteAllByTenantPk(ticketsTable, tenantId);
  console.log(`  ${ticketsDeleted} ticket(s) borrados.`);
  const widgetsDeleted = await deleteAllByTenantPk(widgetsTable, tenantId);
  console.log(`  ${widgetsDeleted} widget(s) borrados.`);
  const agentsDeleted = await deleteAllByTenantPk(agentsTable, tenantId);
  console.log(`  ${agentsDeleted} agente(s) borrados.`);
  const codesDeleted = await deleteActivationCodes(activationCodesTable, tenantId);
  console.log(`  ${codesDeleted} código(s) de activación borrados.`);

  const rawObjectsDeleted = await deletePrefix(rawBucket, `tenants/${tenantId}/`);
  console.log(`  ${rawObjectsDeleted} objeto(s) de tickets crudos borrados en S3.`);
  const analyticsObjectsDeleted = await deletePrefix(analyticsBucket, `tenant=${tenantId}/`);
  console.log(`  ${analyticsObjectsDeleted} fila(s) de analítica borradas en S3.`);

  const users = await findTenantUsers(cognito, userPoolId, tenantId);
  for (const user of users) {
    if (!user.Username) continue;
    await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: user.Username }));
    console.log(`  usuario de Cognito borrado: ${user.Username}.`);
  }

  await ddb.send(new DeleteCommand({ TableName: tenantsTable, Key: { pk: `TENANT#${tenantId}` } }));
  console.log(`Listo: tenant ${tenantId} borrado por completo.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
