// Script administrativo — se corre a mano (con credenciales AWS reales)
// cada vez que se suma un negocio nuevo. No se despliega, no es parte del
// stack: crea la API key en API Gateway (fallback legacy para agentes,
// ver más abajo), da de alta el registro del tenant en DynamoDB, le
// genera sus 5 códigos de activación de robots (ver
// `agents/activateHandler.ts`), y crea el usuario de Cognito con el que
// el negocio va a loguearse en el dashboard.
//
// Uso:
//   TICKET_STACK_USAGE_PLAN_ID=... TENANTS_TABLE=... ACTIVATION_CODES_TABLE=... USER_POOL_ID=... \
//     npx tsx scripts/onboard-tenant.ts --business "La Esquina del Sabor" --parser example-38col --email dueño@negocio.com
import { randomUUID } from "node:crypto";

import { APIGatewayClient, CreateApiKeyCommand, CreateUsagePlanKeyCommand } from "@aws-sdk/client-api-gateway";
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

import { generateActivationCode } from "../src/shared/activationCode.js";

// Tope de robots por tenant, por ahora — ver PROYECTO.md. No hay endpoint
// para generar más códigos, así que subir este número más adelante implica
// correr un script aparte para los tenants ya existentes, no solo cambiar
// esta constante.
const ACTIVATION_CODES_PER_TENANT = 5;

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

// Cumple la política default de Cognito (mín. 8 caracteres, mayúscula,
// minúscula, dígito, símbolo) sin depender de qué le toque al azar — se
// fuerza una de cada categoría y se completa el largo con un UUID.
function generateTempPassword(): string {
  return `Aa1!${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

async function main(): Promise<void> {
  const businessName = requireArg("business");
  const parserId = requireArg("parser");
  const email = requireArg("email");
  const usagePlanId = requireEnv("TICKET_STACK_USAGE_PLAN_ID");
  const tenantsTable = requireEnv("TENANTS_TABLE");
  const activationCodesTable = requireEnv("ACTIVATION_CODES_TABLE");
  const userPoolId = requireEnv("USER_POOL_ID");

  const apigw = new APIGatewayClient({});
  const cognito = new CognitoIdentityProviderClient({});
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

  // Códigos de activación de robots — de a uno por agente que se instale
  // (ver `agents/activateHandler.ts`). Se generan acá, no bajo demanda,
  // porque el tope de 5 es estructural: no existe un endpoint para pedir
  // "un código más".
  const codes: string[] = [];
  for (let i = 0; i < ACTIVATION_CODES_PER_TENANT; i++) {
    const code = generateActivationCode();
    codes.push(code);
    await ddb.send(
      new PutCommand({
        TableName: activationCodesTable,
        Item: {
          pk: `CODE#${code}`,
          tenantId,
          code,
          status: "unused",
          createdAt: new Date().toISOString(),
        },
      }),
    );
  }

  // Usuario de Cognito para loguearse en innoapp-web-user-client.
  // `custom:tenantId` es el único vínculo entre esta persona y su
  // negocio — lo lee `shared/auth.ts` del JWT en cada request del
  // dashboard, nunca se confía en nada que mande el cliente. Se crea con
  // `MessageAction: "SUPPRESS"` (no hay SES configurado para mandar el
  // mail de invitación) y la contraseña queda permanente de una — sin
  // esto, Cognito deja al usuario en estado FORCE_CHANGE_PASSWORD y haría
  // falta un flujo de "cambiar contraseña en el primer login" que todavía
  // no existe en el frontend.
  await cognito.send(
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
  const password = generateTempPassword();
  await cognito.send(
    new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: email, Password: password, Permanent: true }),
  );

  console.log("Tenant creado:");
  console.log(`  tenantId:    ${tenantId}`);
  console.log(`  negocio:     ${businessName}`);
  console.log(`  parser:      ${parserId}`);
  console.log(`\nLogin del dashboard (innoapp-web-user-client):`);
  console.log(`  email:       ${email}`);
  console.log(`  password:    ${password}`);
  console.log("\nAPI key (legacy, NO es para el dashboard):");
  console.log(`  ${apiKey.value}`);
  console.log("Solo la sigue aceptando `ingest` como fallback si un agente viejo no");
  console.log("se activó todavía por código (ver POST /agents/activate). El dashboard");
  console.log("y sus lecturas (GET /tickets, /widgets, /agents, /activation-codes) usan");
  console.log("el login de arriba, no esta key.");
  console.log(`\nCódigos de activación de robots (${ACTIVATION_CODES_PER_TENANT}, un solo uso cada uno):`);
  codes.forEach((code) => console.log(`  ${code}`));
  console.log("\nCada código se canjea UNA vez, al instalar un print-capture-agent nuevo");
  console.log("(POST /agents/activate) — a cambio, ese agente recibe su propia API key.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
