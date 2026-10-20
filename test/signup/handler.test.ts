import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent } from "aws-lambda";

const mockCognitoSend = jest.fn();
const mockDdbSend = jest.fn();

// Mundo simulado: usuarios de Cognito y tablas de DynamoDB en memoria, con fallos inyectables por paso.
const users = new Map<string, { tenantId: string; passwordSet: boolean }>();
const tenants = new Map<string, Record<string, any>>();
const codes = new Map<string, Record<string, any>>();
let failures: Record<string, Error[]> = {};
const failOnce = (step: string, error = new Error(`${step} falló`)) => {
  (failures[step] ??= []).push(error);
};
const maybeFail = (step: string) => {
  const error = failures[step]?.shift();
  if (error) throw error;
};

jest.mock("@aws-sdk/client-cognito-identity-provider", () => {
  const actual = jest.requireActual("@aws-sdk/client-cognito-identity-provider");
  return {
    ...actual,
    CognitoIdentityProviderClient: jest.fn().mockImplementation(() => ({ send: (...args: unknown[]) => mockCognitoSend(...args) })),
  };
});
jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return {
    ...actual,
    ddb: { send: (...args: unknown[]) => mockDdbSend(...args) },
    TENANTS_TABLE: "TestTenants",
    ACTIVATION_CODES_TABLE: "TestCodes",
    SIGNUP_USAGE_TABLE: "TestSignupUsage",
  };
});

import { InvalidPasswordException, UserNotFoundException, UsernameExistsException } from "@aws-sdk/client-cognito-identity-provider";

import { handler } from "../../src/signup/handler";

function event(body: unknown, sourceIp: string | null = "1.2.3.4"): APIGatewayProxyEvent {
  return {
    body: body === undefined ? null : JSON.stringify(body),
    requestContext: { identity: { sourceIp } },
  } as unknown as APIGatewayProxyEvent;
}

function validBody() {
  return { businessName: "La Esquina del Sabor", email: "dueno@negocio.com", password: "Aa1!aaaa" };
}

const conditionalFailure = () => new ConditionalCheckFailedException({ message: "condición", $metadata: {} });

function fakeCognito(command: any) {
  const kind = command.constructor.name as string;
  const input = command.input;
  maybeFail(kind);
  if (kind === "AdminCreateUserCommand") {
    if (users.has(input.Username)) throw new UsernameExistsException({ message: "ya existe", $metadata: {} });
    const tenantId = input.UserAttributes.find((a: any) => a.Name === "custom:tenantId").Value;
    users.set(input.Username, { tenantId, passwordSet: false });
    return {};
  }
  if (kind === "AdminGetUserCommand") {
    const user = users.get(input.Username);
    if (!user) throw new UserNotFoundException({ message: "no existe", $metadata: {} });
    return { UserAttributes: user.tenantId ? [{ Name: "custom:tenantId", Value: user.tenantId }] : [] };
  }
  if (kind === "AdminSetUserPasswordCommand") {
    users.get(input.Username)!.passwordSet = true;
    return {};
  }
  if (kind === "AdminDeleteUserCommand") {
    users.delete(input.Username);
    return {};
  }
  throw new Error(`comando de Cognito no simulado: ${kind}`);
}

function fakeDdb(command: any) {
  const kind = command.constructor.name as string;
  const input = command.input;
  if (input.TableName === "TestSignupUsage") return {}; // rate limit: pasa
  if (input.TableName === "TestTenants") {
    if (kind === "PutCommand") {
      maybeFail("putTenant");
      if (tenants.has(input.Item.pk)) throw conditionalFailure();
      tenants.set(input.Item.pk, { ...input.Item });
      return {};
    }
    if (kind === "GetCommand") return { Item: tenants.get(input.Key.pk) ? { ...tenants.get(input.Key.pk) } : undefined };
    if (kind === "UpdateCommand") {
      maybeFail("finish");
      delete tenants.get(input.Key.pk)!.signupState;
      return {};
    }
  }
  if (input.TableName === "TestCodes") {
    if (kind === "PutCommand") {
      maybeFail("putCode");
      codes.set(input.Item.pk, { ...input.Item });
      return {};
    }
    if (kind === "QueryCommand") {
      const tenantId = input.ExpressionAttributeValues[":tenantId"];
      return { Count: [...codes.values()].filter((c) => c.tenantId === tenantId).length };
    }
  }
  throw new Error(`comando de DynamoDB no simulado: ${kind} en ${input.TableName}`);
}

const codesOf = (tenantId: string) => [...codes.values()].filter((c) => c.tenantId === tenantId);

beforeEach(() => {
  jest.useFakeTimers({ now: Date.parse("2026-10-20T12:00:00.000Z") });
  users.clear();
  tenants.clear();
  codes.clear();
  failures = {};
  mockCognitoSend.mockReset();
  mockCognitoSend.mockImplementation(async (command) => fakeCognito(command));
  mockDdbSend.mockReset();
  mockDdbSend.mockImplementation(async (command) => fakeDdb(command));
  process.env.USER_POOL_ID = "test-pool";
});

afterEach(() => jest.useRealTimers());

test("rechaza si no se puede resolver el origen del request", async () => {
  const result = await handler(event(validBody(), null));
  expect(result.statusCode).toBe(400);
  expect(mockCognitoSend).not.toHaveBeenCalled();
});

test("429 si se supera el rate limit por IP: no llega a Cognito", async () => {
  mockDdbSend.mockRejectedValueOnce(new ConditionalCheckFailedException({ message: "límite", $metadata: {} }));

  const result = await handler(event(validBody()));

  expect(result.statusCode).toBe(429);
  expect(mockCognitoSend).not.toHaveBeenCalled();
});

test("rechaza businessName vacío", async () => {
  const result = await handler(event({ ...validBody(), businessName: "  " }));
  expect(result.statusCode).toBe(400);
  expect(mockCognitoSend).not.toHaveBeenCalled();
});

test("rechaza email inválido", async () => {
  const result = await handler(event({ ...validBody(), email: "no-es-un-email" }));
  expect(result.statusCode).toBe(400);
  expect(mockCognitoSend).not.toHaveBeenCalled();
});

test("rechaza password demasiado corta", async () => {
  const result = await handler(event({ ...validBody(), password: "corta1" }));
  expect(result.statusCode).toBe(400);
  expect(mockCognitoSend).not.toHaveBeenCalled();
});


test("éxito: crea el usuario, el negocio completo y los 5 códigos de activación", async () => {
  const result = await handler(event(validBody()));

  expect(result.statusCode).toBe(201);
  const { tenantId } = JSON.parse(result.body);
  expect(tenantId).toEqual(expect.any(String));

  // Cognito: crea el usuario con su tenantId y le setea la contraseña que eligió.
  expect(users.get("dueno@negocio.com")).toEqual({ tenantId, passwordSet: true });
  const setPassword = mockCognitoSend.mock.calls.find(([c]) => c.constructor.name === "AdminSetUserPasswordCommand")![0].input;
  expect(setPassword).toMatchObject({ Password: "Aa1!aaaa", Permanent: true });

  const tenant = tenants.get(`TENANT#${tenantId}`)!;
  expect(tenant).toMatchObject({ tenantId, businessName: "La Esquina del Sabor", parserId: "example-38col", onboarding: { version: 1 } });
  expect(tenant.signupState).toBeUndefined(); // terminó: ya no figura como "provisioning"
  // Sin api-key compartida — un tenant nuevo nunca la necesita (ver shared/types.ts sobre apiKeyId).
  expect(tenant.apiKeyId).toBeUndefined();

  const created = codesOf(tenantId);
  expect(created).toHaveLength(5);
  expect(new Set(created.map((c) => c.code)).size).toBe(5); // los 5 códigos son distintos
  created.forEach((c) => expect(c.status).toBe("unused"));
});

test("409 si el email ya tiene una cuenta completa: no escribe nada", async () => {
  await handler(event(validBody()));
  const tenantsBefore = tenants.size;
  const codesBefore = codes.size;

  const result = await handler(event({ ...validBody(), businessName: "Otro negocio" }));

  expect(result.statusCode).toBe(409);
  expect(tenants.size).toBe(tenantsBefore);
  expect(codes.size).toBe(codesBefore);
});

test("409 si el usuario existe pero no es de este flujo (sin tenantId): no lo toca", async () => {
  users.set("dueno@negocio.com", { tenantId: "", passwordSet: true });
  const result = await handler(event(validBody()));
  expect(result.statusCode).toBe(409);
  expect(users.get("dueno@negocio.com")!.passwordSet).toBe(true);
  expect(tenants.size).toBe(0);
});

test("409 para un negocio anterior a signupState (sin la marca): nunca se considera incompleto", async () => {
  users.set("dueno@negocio.com", { tenantId: "legacy-1", passwordSet: true });
  tenants.set("TENANT#legacy-1", { pk: "TENANT#legacy-1", tenantId: "legacy-1", businessName: "Viejo", createdAt: "2026-01-01T00:00:00.000Z" });

  const result = await handler(event(validBody()));

  expect(result.statusCode).toBe(409);
  expect(tenants.get("TENANT#legacy-1")!.businessName).toBe("Viejo");
});

test("400 si la contraseña no cumple la política: limpia el usuario huérfano y no escribe el negocio", async () => {
  failOnce("AdminSetUserPasswordCommand", new InvalidPasswordException({ message: "débil", $metadata: {} }));

  const result = await handler(event(validBody()));

  expect(result.statusCode).toBe(400);
  expect(users.size).toBe(0);
  expect(tenants.size).toBe(0);
});

describe("registro interrumpido: reintentar con el mismo email lo completa", () => {
  test("se cae al crear el negocio: el reintento reutiliza el usuario y el tenantId, sin dejar el email bloqueado", async () => {
    failOnce("putTenant");
    await expect(handler(event(validBody()))).rejects.toThrow();
    const orphan = users.get("dueno@negocio.com")!;
    expect(orphan.passwordSet).toBe(true);
    expect(tenants.size).toBe(0);

    const retry = await handler(event(validBody()));

    expect(retry.statusCode).toBe(201);
    expect(JSON.parse(retry.body).tenantId).toBe(orphan.tenantId);
    expect(users.size).toBe(1);
    expect(codesOf(orphan.tenantId)).toHaveLength(5);
    expect(tenants.get(`TENANT#${orphan.tenantId}`)!.signupState).toBeUndefined();
  });

  test("se cae a mitad de los códigos: el reintento completa hasta 5, nunca más", async () => {
    // Los 5 puts salen en paralelo; el 4º y el 5º fallan.
    let puts = 0;
    mockDdbSend.mockImplementation(async (command: any) => {
      if (command.input.TableName === "TestCodes" && command.constructor.name === "PutCommand" && ++puts > 3) {
        throw new Error("DynamoDB no disponible");
      }
      return fakeDdb(command);
    });
    await expect(handler(event(validBody()))).rejects.toThrow();
    const { tenantId } = users.get("dueno@negocio.com")!;
    expect(codesOf(tenantId)).toHaveLength(3);
    expect(tenants.get(`TENANT#${tenantId}`)!.signupState).toBe("provisioning");

    mockDdbSend.mockImplementation(async (command: any) => fakeDdb(command));
    const retry = await handler(event(validBody()));

    expect(retry.statusCode).toBe(201);
    expect(codesOf(tenantId)).toHaveLength(5);
    expect(tenants.get(`TENANT#${tenantId}`)!.signupState).toBeUndefined();
  });

  test("se cae en el último paso: el reintento dentro de la ventana cierra el registro", async () => {
    failOnce("finish");
    await expect(handler(event(validBody()))).rejects.toThrow();
    const { tenantId } = users.get("dueno@negocio.com")!;
    expect(tenants.get(`TENANT#${tenantId}`)!.signupState).toBe("provisioning");

    jest.setSystemTime(Date.now() + 5 * 60_000);
    const retry = await handler(event(validBody()));

    expect(retry.statusCode).toBe(201);
    expect(codesOf(tenantId)).toHaveLength(5); // no se duplicaron
    expect(tenants.get(`TENANT#${tenantId}`)!.signupState).toBeUndefined();
  });

  test("pasada la ventana, un negocio 'provisioning' NO se reanuda: nadie puede tomar el email cambiando la contraseña", async () => {
    failOnce("finish");
    await expect(handler(event(validBody()))).rejects.toThrow();
    const { tenantId } = users.get("dueno@negocio.com")!;

    jest.setSystemTime(Date.now() + 16 * 60_000);
    const attacker = await handler(event({ ...validBody(), password: "Zz9!zzzz" }));

    expect(attacker.statusCode).toBe(409);
    const passwordCalls = mockCognitoSend.mock.calls.filter(([c]) => c.constructor.name === "AdminSetUserPasswordCommand");
    expect(passwordCalls).toHaveLength(1); // solo la del primer intento
    expect(users.get("dueno@negocio.com")!.tenantId).toBe(tenantId);
  });

  test("al reanudar con una contraseña inválida no se borra el usuario (el reintento lo retoma)", async () => {
    failOnce("putTenant");
    await expect(handler(event(validBody()))).rejects.toThrow();

    failOnce("AdminSetUserPasswordCommand", new InvalidPasswordException({ message: "débil", $metadata: {} }));
    const bad = await handler(event({ ...validBody(), password: "Aa1!aaaa" }));
    expect(bad.statusCode).toBe(400);
    expect(users.has("dueno@negocio.com")).toBe(true);

    const good = await handler(event(validBody()));
    expect(good.statusCode).toBe(201);
  });

  test("la conservación del createdAt original: reanudar no reescribe el negocio", async () => {
    failOnce("putCode");
    await expect(handler(event(validBody()))).rejects.toThrow();
    const { tenantId } = users.get("dueno@negocio.com")!;
    const createdAt = tenants.get(`TENANT#${tenantId}`)!.createdAt;

    jest.setSystemTime(Date.now() + 60_000);
    await handler(event({ ...validBody(), businessName: "Nombre distinto" }));

    expect(tenants.get(`TENANT#${tenantId}`)).toMatchObject({ createdAt, businessName: "La Esquina del Sabor" });
  });
});
