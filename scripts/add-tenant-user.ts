// Script administrativo — suma una persona a un negocio YA existente (mismo tenant, mismos datos) con
// su propia vista: sus widgets (los compartidos del negocio no los ve) y sus prompts sugeridos.
// Crea el usuario de Cognito con `custom:tenantId`, registra su `sub` en `userViews` del tenant y
// siembra sus widgets iniciales. Por defecto solo muestra qué haría; con --apply escribe.
//
// Uso (desde ticket-parsing-cloud/, con credenciales AWS):
//   npm run add-tenant-user -- --tenant <tenantId> --email persona@negocio.com --profile scripts/profiles/alamo-comercial.example.json
//   npm run add-tenant-user -- --tenant <tenantId> --email persona@negocio.com --profile <archivo.json> --apply
//
// Para cambiar los prompts/widgets de alguien ya creado: repetir con --existing (no crea el usuario,
// reemplaza sus prompts y SUMA los widgets del archivo).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { widgetKey } from "../src/shared/dynamo.js";
import { validateBody } from "../src/widgets/createHandler.js";
import { readStackOutputs, requireOutput } from "./lib/stackOutputs.js";

const has = (flag: string) => process.argv.includes(`--${flag}`);
function requireArg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`falta --${name}`);
  return value;
}

type Profile = { label?: string; suggestedPrompts?: Array<{ q: string; label: string }>; widgets?: unknown[] };

function loadProfile(path: string): Profile {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Profile;
  for (const p of raw.suggestedPrompts ?? []) {
    if (typeof p.q !== "string" || typeof p.label !== "string" || !p.q.trim() || !p.label.trim()) {
      throw new Error("cada suggestedPrompts necesita { q, label } con texto");
    }
  }
  if ((raw.suggestedPrompts?.length ?? 0) > 12) throw new Error("máximo 12 suggestedPrompts");
  return raw;
}

async function main(): Promise<void> {
  const tenantId = requireArg("tenant");
  const email = requireArg("email").trim().toLowerCase();
  const profile = loadProfile(requireArg("profile"));
  const apply = has("apply");
  const existing = has("existing");

  const widgets = (profile.widgets ?? []).map((w, i) => {
    const v = validateBody(w);
    if (!v.ok) throw new Error(`widget #${i + 1} inválido: ${v.error}`);
    return v.value;
  });

  const outputs = readStackOutputs();
  const tenantsTable = requireOutput(outputs, "TenantsTableName");
  const widgetsTable = requireOutput(outputs, "WidgetsTableName");
  const userPoolId = requireOutput(outputs, "UserPoolId");
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
  const cognito = new CognitoIdentityProviderClient({ region: "us-east-1" });

  const { Item: tenant } = await ddb.send(new GetCommand({ TableName: tenantsTable, Key: { pk: `TENANT#${tenantId}` }, ConsistentRead: true }));
  if (!tenant) throw new Error(`no existe ningún tenant con id ${tenantId}`);

  console.log(`Negocio: ${tenant.businessName} (${tenantId})`);
  console.log(`Persona: ${email} ${existing ? "(ya existe en Cognito)" : "(usuario nuevo)"}`);
  console.log(`Prompts: ${profile.suggestedPrompts?.length ?? 0} | Widgets iniciales: ${widgets.length}`);
  if (!apply) {
    console.log("(corrida en seco: agregá --apply para escribir)");
    return;
  }

  let password: string | undefined;
  let sub: string;
  if (existing) {
    const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
    const attrs = Object.fromEntries((user.UserAttributes ?? []).map((a) => [a.Name, a.Value]));
    if (attrs["custom:tenantId"] !== tenantId) throw new Error("ese usuario no pertenece a este negocio");
    sub = attrs.sub as string;
  } else {
    const created = await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
          { Name: "custom:tenantId", Value: tenantId },
        ],
        MessageAction: "SUPPRESS",
      }),
    );
    sub = created.User?.Attributes?.find((a) => a.Name === "sub")?.Value as string;
    if (!sub) throw new Error("Cognito no devolvió el sub del usuario nuevo");
    password = `Aa1!${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: email, Password: password, Permanent: true }));
  }

  // Primero la vista propia (así sus widgets nunca quedan visibles para el resto), después los widgets.
  await ddb.send(
    new UpdateCommand({
      TableName: tenantsTable,
      Key: { pk: `TENANT#${tenantId}` },
      UpdateExpression: "SET userViews = if_not_exists(userViews, :empty)",
      ExpressionAttributeValues: { ":empty": {} },
    }),
  );
  await ddb.send(
    new UpdateCommand({
      TableName: tenantsTable,
      Key: { pk: `TENANT#${tenantId}` },
      UpdateExpression: "SET userViews.#sub = :view",
      ExpressionAttributeNames: { "#sub": sub },
      ExpressionAttributeValues: {
        ":view": { ...(profile.label ? { label: profile.label } : {}), ...(profile.suggestedPrompts?.length ? { suggestedPrompts: profile.suggestedPrompts } : {}) },
      },
    }),
  );
  const now = new Date().toISOString();
  for (const w of widgets) {
    const widgetId = randomUUID();
    await ddb.send(
      new PutCommand({ TableName: widgetsTable, Item: { tenantId, widgetId, createdAt: now, userId: sub, ...w, ...widgetKey(tenantId, widgetId) } }),
    );
  }

  console.log("\nListo.");
  console.log(`  sub:      ${sub}`);
  if (password) {
    console.log("\nLogin del dashboard:");
    console.log(`  email:    ${email}`);
    console.log(`  password: ${password}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
