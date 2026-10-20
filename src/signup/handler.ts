import { randomUUID } from "node:crypto";

import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InvalidPasswordException,
  UserNotFoundException,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { generateActivationCode } from "../shared/activationCode.js";
import { ACTIVATION_CODES_TABLE, ddb, TENANTS_TABLE } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import { getTenant } from "../shared/tenant.js";
import type { TenantRecord } from "../shared/types.js";
import { checkSignupRateLimit } from "./rateLimit.js";

const cognito = new CognitoIdentityProviderClient({});

// Único parser real que existe hoy (sección 9 de PROYECTO.md) — todo tenant
// que se da de alta, manual o self-service, arranca con este. El día que
// haya más de uno, esto deja de ser una constante y pasa a elegirse en el
// formulario (o se resuelve después con `assign-port-parser.ts`).
const DEFAULT_PARSER_ID = "example-38col";

// Tope de robots por tenant — igual que `onboard-tenant.ts`. No hay
// endpoint para pedir un código más, así que subir esto más adelante
// implica un script aparte para tenants ya existentes.
const ACTIVATION_CODES_PER_TENANT = 5;

/** Cuánto después de empezar un registro puede reanudarse con el mismo email (ver `findInterruptedSignup`). */
const RESUME_WINDOW_MS = 15 * 60_000;

const MAX_BUSINESS_NAME_LENGTH = 100;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type SignupBody = { businessName: string; email: string; password: string };
type Validation = { ok: true; value: SignupBody } | { ok: false; error: string };

function validateBody(body: unknown): Validation {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "se esperaba un objeto JSON" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.businessName !== "string" || b.businessName.trim().length === 0 || b.businessName.length > MAX_BUSINESS_NAME_LENGTH) {
    return { ok: false, error: `businessName inválido (no vacío, máx ${MAX_BUSINESS_NAME_LENGTH} caracteres)` };
  }
  if (typeof b.email !== "string" || !EMAIL_PATTERN.test(b.email)) {
    return { ok: false, error: "email inválido" };
  }
  // Cognito valida la política real (mayúscula/minúscula/número/símbolo) —
  // acá solo se chequea el largo, barato, antes de llamar a la API.
  if (typeof b.password !== "string" || b.password.length < MIN_PASSWORD_LENGTH || b.password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `password inválida (mín ${MIN_PASSWORD_LENGTH}, máx ${MAX_PASSWORD_LENGTH} caracteres)` };
  }

  return { ok: true, value: { businessName: b.businessName.trim(), email: b.email, password: b.password } };
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const sourceIp = event.requestContext.identity?.sourceIp;
  if (!sourceIp) {
    return jsonResponse(400, { error: "no se pudo resolver el origen del request" });
  }

  const rateLimit = await checkSignupRateLimit(sourceIp);
  if (!rateLimit.ok) {
    return jsonResponse(429, { error: "demasiados registros desde este origen, probá de nuevo más tarde" });
  }

  let body: unknown;
  try {
    body = event.body ? JSON.parse(event.body) : null;
  } catch {
    return jsonResponse(400, { error: "body inválido, se esperaba JSON" });
  }

  const validation = validateBody(body);
  if (!validation.ok) {
    return jsonResponse(400, { error: validation.error });
  }
  const { businessName, email, password } = validation.value;

  let tenantId: string = randomUUID();
  let resumed = false;

  const userPoolId = process.env.USER_POOL_ID!;

  // Se crea el usuario de Cognito ANTES que el tenant: si el email ya existe
  // (UsernameExistsException) y es una cuenta completa, se corta acá sin haber
  // escrito nada en DynamoDB — nada que limpiar después.
  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
          { Name: "custom:tenantId", Value: tenantId },
        ],
        // Sin SES configurado — no hay mail de invitación que mandar. La
        // persona ya eligió su contraseña en el formulario, no hace falta
        // ningún flujo de "primer login".
        MessageAction: "SUPPRESS",
      }),
    );
  } catch (err) {
    if (!(err instanceof UsernameExistsException)) throw err;

    // El email ya tiene usuario. Si su negocio quedó sin crear o a medias, es un
    // registro interrumpido (corte de conexión, timeout): se reanuda con el mismo
    // tenantId en vez de dejar el email bloqueado para siempre. Una cuenta
    // completa sigue dando 409. Reanudar no expone nada: el negocio incompleto no
    // tiene datos, y el registro ya era "el primero que llega" (no hay verificación
    // de email).
    const interrupted = await findInterruptedSignup(userPoolId, email);
    if (!interrupted) {
      return jsonResponse(409, { error: "ya existe una cuenta con ese email" });
    }
    tenantId = interrupted;
    resumed = true;
  }

  // Paso separado: si la contraseña no cumple la política (InvalidPasswordException),
  // el usuario de Cognito del paso anterior ya existe — sin borrarlo, la
  // persona quedaría con una cuenta huérfana (sin contraseña utilizable) que
  // además bloquea reintentar con el mismo email (UsernameExistsException).
  try {
    await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: email, Password: password, Permanent: true }));
  } catch (err) {
    // Al reanudar no se borra: ese usuario ya traía su negocio a medias y un reintento lo retoma.
    if (!resumed) {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email })).catch(() => {});
    }
    if (err instanceof InvalidPasswordException) {
      return jsonResponse(400, { error: "la contraseña no cumple los requisitos (mín. 8 caracteres, mayúscula, minúscula, número y símbolo)" });
    }
    throw err;
  }

  // El negocio nace "provisioning" y solo pasa a completo al final, cuando ya
  // tiene sus 5 códigos. Si este request se corta antes, el reintento lo retoma.
  const tenant: TenantRecord = {
    tenantId,
    businessName,
    parserId: DEFAULT_PARSER_ID,
    portParsers: {},
    createdAt: new Date().toISOString(),
    onboarding: { version: 1 },
    signupState: "provisioning",
  };
  try {
    await ddb.send(
      new PutCommand({
        TableName: TENANTS_TABLE,
        Item: { ...tenant, pk: `TENANT#${tenantId}` },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  } catch (err) {
    // Un intento anterior ya lo creó: se conserva (con su createdAt original).
    if (!(err instanceof ConditionalCheckFailedException)) throw err;
  }

  // Códigos de activación de robots — mismo mecanismo que `onboard-tenant.ts`
  // (sección 9.3 de PROYECTO.md). Se generan acá, no bajo demanda: el tope
  // de 5 es estructural, no hay endpoint para pedir uno más. Solo se crean los
  // que faltan, así un reintento nunca pasa de 5.
  const existing = await ddb.send(
    new QueryCommand({
      TableName: ACTIVATION_CODES_TABLE,
      IndexName: "tenantId-index",
      KeyConditionExpression: "tenantId = :tenantId",
      ExpressionAttributeValues: { ":tenantId": tenantId },
      Select: "COUNT",
    }),
  );
  const missing = Math.max(0, ACTIVATION_CODES_PER_TENANT - (existing.Count ?? 0));
  await Promise.all(
    Array.from({ length: missing }, () => generateActivationCode()).map((code) =>
      ddb.send(
        new PutCommand({
          TableName: ACTIVATION_CODES_TABLE,
          Item: { pk: `CODE#${code}`, tenantId, code, status: "unused", createdAt: new Date().toISOString() },
        }),
      ),
    ),
  );

  await ddb.send(
    new UpdateCommand({
      TableName: TENANTS_TABLE,
      Key: { pk: `TENANT#${tenantId}` },
      UpdateExpression: "REMOVE signupState",
    }),
  );

  return jsonResponse(201, { tenantId });
}

/**
 * Devuelve el tenantId de un usuario cuyo registro quedó a medias, o `undefined`
 * si la cuenta está completa (o no es de este flujo). A medias = el usuario existe
 * pero su negocio no se creó, o se creó y sigue en `provisioning`. Los negocios
 * anteriores a `signupState` nunca lo tienen, así que jamás se consideran incompletos.
 */
async function findInterruptedSignup(userPoolId: string, email: string): Promise<string | undefined> {
  let user;
  try {
    user = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
  } catch (err) {
    if (err instanceof UserNotFoundException) return undefined;
    throw err;
  }
  const tenantId = user.UserAttributes?.find((attribute) => attribute.Name === "custom:tenantId")?.Value;
  if (!tenantId) return undefined;

  const tenant = await getTenant(tenantId, { consistentRead: true });
  if (!tenant) return tenantId; // usuario sin negocio: no hay datos que proteger
  // Un negocio "provisioning" solo se reanuda mientras el registro es reciente. Si el
  // último paso (quitar la marca) fallara en una cuenta que ya funciona, pasada la
  // ventana nadie puede tomar ese email cambiándole la contraseña: se queda en 409 y
  // lo resuelve un operador, en vez de abrir una vía de secuestro de cuenta.
  const age = Date.now() - Date.parse(tenant.createdAt);
  return tenant.signupState === "provisioning" && age < RESUME_WINDOW_MS ? tenantId : undefined;
}
