import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent } from "aws-lambda";

const mockCognitoSend = jest.fn();
const mockDdbSend = jest.fn();

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

import { InvalidPasswordException, UsernameExistsException } from "@aws-sdk/client-cognito-identity-provider";

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

beforeEach(() => {
  mockCognitoSend.mockReset();
  mockDdbSend.mockReset();
  mockDdbSend.mockResolvedValue({}); // rate limit pasa por defecto
  process.env.USER_POOL_ID = "test-pool";
});

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

test("éxito: crea el usuario, el tenant y los 5 códigos de activación", async () => {
  mockCognitoSend.mockResolvedValue({});

  const result = await handler(event(validBody()));

  expect(result.statusCode).toBe(201);
  const body = JSON.parse(result.body);
  expect(body.tenantId).toEqual(expect.any(String));

  // Cognito: crea el usuario y le setea la contraseña que eligió, nada más.
  expect(mockCognitoSend).toHaveBeenCalledTimes(2);
  const createUserInput = mockCognitoSend.mock.calls[0][0].input;
  expect(createUserInput.Username).toBe("dueno@negocio.com");
  expect(createUserInput.UserAttributes).toEqual(
    expect.arrayContaining([{ Name: "custom:tenantId", Value: body.tenantId }]),
  );
  const setPasswordInput = mockCognitoSend.mock.calls[1][0].input;
  expect(setPasswordInput.Password).toBe("Aa1!aaaa");
  expect(setPasswordInput.Permanent).toBe(true);

  // DynamoDB: 1 rate limit + 1 tenant + 5 códigos.
  expect(mockDdbSend).toHaveBeenCalledTimes(7);
  const tenantPut = mockDdbSend.mock.calls[1][0].input;
  expect(tenantPut.TableName).toBe("TestTenants");
  expect(tenantPut.Item).toMatchObject({ tenantId: body.tenantId, businessName: "La Esquina del Sabor", parserId: "example-38col" });
  // Sin api-key compartida — un tenant nuevo nunca la necesita (ver el
  // comentario en shared/types.ts sobre apiKeyId).
  expect(tenantPut.Item.apiKeyId).toBeUndefined();

  const codeWrites = mockDdbSend.mock.calls.slice(2);
  expect(codeWrites).toHaveLength(5);
  const codes = codeWrites.map(([cmd]) => cmd.input.Item.code as string);
  expect(new Set(codes).size).toBe(5); // los 5 códigos son distintos
  codeWrites.forEach(([cmd]) => {
    expect(cmd.input.TableName).toBe("TestCodes");
    expect(cmd.input.Item).toMatchObject({ tenantId: body.tenantId, status: "unused" });
  });
});

test("409 si el email ya existe: no escribe nada en DynamoDB más allá del rate limit", async () => {
  mockCognitoSend.mockRejectedValue(new UsernameExistsException({ message: "ya existe", $metadata: {} }));

  const result = await handler(event(validBody()));

  expect(result.statusCode).toBe(409);
  expect(mockCognitoSend).toHaveBeenCalledTimes(1);
  expect(mockDdbSend).toHaveBeenCalledTimes(1); // solo el rate limit
});

test("400 si la contraseña no cumple la política: limpia el usuario huérfano y no escribe el tenant", async () => {
  mockCognitoSend
    .mockResolvedValueOnce({}) // AdminCreateUserCommand
    .mockRejectedValueOnce(new InvalidPasswordException({ message: "débil", $metadata: {} })) // AdminSetUserPasswordCommand
    .mockResolvedValueOnce({}); // AdminDeleteUserCommand (limpieza)

  const result = await handler(event(validBody()));

  expect(result.statusCode).toBe(400);
  expect(mockCognitoSend).toHaveBeenCalledTimes(3);
  expect(mockCognitoSend.mock.calls[2][0].constructor.name).toBe("AdminDeleteUserCommand");
  expect(mockDdbSend).toHaveBeenCalledTimes(1); // solo el rate limit, nunca llegó a crear el tenant
});
