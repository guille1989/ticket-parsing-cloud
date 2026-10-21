import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

// La autorización se verifica con el helper real en shared/humanAuthorization.test.ts.
jest.mock("../../src/shared/auth", () => ({
  resolveActiveTenantIdFromEvent: jest.fn(async (event: APIGatewayProxyWithCognitoAuthorizerEvent) =>
    event.requestContext?.authorizer?.claims?.["custom:tenantId"]),
  resolveUserIdFromEvent: jest.fn((event: APIGatewayProxyWithCognitoAuthorizerEvent) =>
    event.requestContext?.authorizer?.claims?.sub),
}));

const mockDdbSend = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, CONVERSATIONS_TABLE: "TestConversations" };
});

import { CONVERSATION_RETENTION_DAYS, MAX_MESSAGES, MAX_TEXT_LENGTH } from "../../src/conversations/conversationStore";
import { handler as getCurrent } from "../../src/conversations/getCurrentHandler";
import { handler as save } from "../../src/conversations/saveHandler";

const CONVERSATION_ID = "2026-10-21T12:00:00.000Z_ab12cd34";

interface EventOptions {
  tenant?: string | null;
  user?: string | null;
  conversationId?: string;
  body?: unknown;
  rawBody?: string;
}

function eventWith({ tenant = "t1", user = "u1", conversationId, body, rawBody }: EventOptions = {}): APIGatewayProxyWithCognitoAuthorizerEvent {
  return {
    requestContext: { authorizer: { claims: { ...(tenant ? { "custom:tenantId": tenant } : {}), ...(user ? { sub: user } : {}) } } },
    pathParameters: conversationId ? { conversationId } : null,
    body: rawBody ?? (body === undefined ? null : JSON.stringify(body)),
  } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;
}

const validBody = {
  messages: [
    { role: "user", text: "¿Cuánto vendimos hoy?" },
    { role: "ai", text: "Vendiste **$100**.", reportId: "2026-10-21T12:00:01.000Z_11223344" },
  ],
  history: [
    { role: "user", text: "¿Cuánto vendimos hoy?" },
    { role: "assistant", text: "Vendiste **$100**." },
  ],
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  mockDdbSend.mockReset();
  mockDdbSend.mockResolvedValue({});
});

describe("GET /assistant/conversation", () => {
  test("consulta la última conversación de esa persona en ese negocio", async () => {
    mockDdbSend.mockResolvedValue({ Items: [] });
    await getCurrent(eventWith());

    const query = mockDdbSend.mock.calls[0][0].input;
    expect(query.TableName).toBe("TestConversations");
    expect(query.ExpressionAttributeValues).toEqual({ ":pk": "TENANT#t1", ":prefix": "CONV#u1#" });
    expect(query.ScanIndexForward).toBe(false);
    expect(query.Limit).toBe(1);
  });

  test("devuelve la conversación guardada", async () => {
    mockDdbSend.mockResolvedValue({
      Items: [{ conversationId: CONVERSATION_ID, ...validBody, updatedAt: "2026-10-21T12:05:00.000Z", ttl: nowSeconds() + 1000 }],
    });
    const result = await getCurrent(eventWith());

    expect(result.statusCode).toBe(200);
    const { conversation } = JSON.parse(result.body);
    expect(conversation.conversationId).toBe(CONVERSATION_ID);
    expect(conversation.messages).toEqual(validBody.messages);
    expect(conversation.history).toEqual(validBody.history);
  });

  test("sin conversaciones devuelve null (200, no un error)", async () => {
    mockDdbSend.mockResolvedValue({ Items: [] });
    const result = await getCurrent(eventWith());

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ conversation: null });
  });

  test("una conversación vencida que DynamoDB todavía no borró se trata como inexistente", async () => {
    mockDdbSend.mockResolvedValue({ Items: [{ conversationId: CONVERSATION_ID, ...validBody, ttl: nowSeconds() - 10 }] });
    const result = await getCurrent(eventWith());

    expect(JSON.parse(result.body)).toEqual({ conversation: null });
  });

  test("sin identidad de usuario (sub) responde 403 sin consultar la tabla", async () => {
    const result = await getCurrent(eventWith({ user: null }));

    expect(result.statusCode).toBe(403);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });
});

describe("PUT /assistant/conversation/{conversationId}", () => {
  test("guarda con la clave del tenant y del usuario autenticados y un TTL de 30 días", async () => {
    const before = nowSeconds();
    const result = await save(eventWith({ conversationId: CONVERSATION_ID, body: validBody }));

    expect(result.statusCode).toBe(204);
    const update = mockDdbSend.mock.calls[0][0].input;
    expect(update.TableName).toBe("TestConversations");
    expect(update.Key).toEqual({ pk: "TENANT#t1", sk: `CONV#u1#${CONVERSATION_ID}` });
    expect(update.ExpressionAttributeValues[":messages"]).toEqual(validBody.messages);
    expect(update.ExpressionAttributeValues[":history"]).toEqual(validBody.history);
    const ttl = update.ExpressionAttributeValues[":ttl"] as number;
    expect(ttl).toBeGreaterThanOrEqual(before + CONVERSATION_RETENTION_DAYS * 86400);
    expect(ttl).toBeLessThanOrEqual(nowSeconds() + CONVERSATION_RETENTION_DAYS * 86400);
    // La fecha de creación se conserva en los guardados siguientes.
    expect(update.UpdateExpression).toContain("createdAt = if_not_exists(createdAt, :now)");
  });

  test("acepta el id con los `:` codificados como llegan desde API Gateway", async () => {
    const result = await save(eventWith({ conversationId: encodeURIComponent(CONVERSATION_ID), body: validBody }));

    expect(result.statusCode).toBe(204);
    expect(mockDdbSend.mock.calls[0][0].input.Key.sk).toBe(`CONV#u1#${CONVERSATION_ID}`);
  });

  test("descarta campos desconocidos de los mensajes", async () => {
    const body = { ...validBody, messages: [{ role: "user", text: "hola", extra: "x".repeat(10), report: { grande: true } }] };
    await save(eventWith({ conversationId: CONVERSATION_ID, body }));

    expect(mockDdbSend.mock.calls[0][0].input.ExpressionAttributeValues[":messages"]).toEqual([{ role: "user", text: "hola" }]);
  });

  test.each([
    ["id con formato inválido", { conversationId: "../otra" }, 400],
    ["sin id", {}, 400],
    ["JSON roto", { conversationId: CONVERSATION_ID, rawBody: "{no es json" }, 400],
    ["sin body", { conversationId: CONVERSATION_ID }, 400],
    ["lista de mensajes vacía", { conversationId: CONVERSATION_ID, body: { ...validBody, messages: [] } }, 400],
    ["demasiados mensajes", { conversationId: CONVERSATION_ID, body: { ...validBody, messages: Array.from({ length: MAX_MESSAGES + 1 }, () => ({ role: "user", text: "x" })) } }, 400],
    ["rol inválido", { conversationId: CONVERSATION_ID, body: { ...validBody, messages: [{ role: "system", text: "x" }] } }, 400],
    ["texto vacío", { conversationId: CONVERSATION_ID, body: { ...validBody, messages: [{ role: "user", text: "  " }] } }, 400],
    ["texto demasiado largo", { conversationId: CONVERSATION_ID, body: { ...validBody, messages: [{ role: "user", text: "x".repeat(MAX_TEXT_LENGTH + 1) }] } }, 400],
    ["reportId que no es string", { conversationId: CONVERSATION_ID, body: { ...validBody, messages: [{ role: "ai", text: "x", reportId: 5 }] } }, 400],
    ["history sin lista", { conversationId: CONVERSATION_ID, body: { messages: validBody.messages } }, 400],
    ["history con demasiados turnos", { conversationId: CONVERSATION_ID, body: { ...validBody, history: Array.from({ length: 7 }, () => ({ role: "user", text: "x" })) } }, 400],
    ["body demasiado grande", { conversationId: CONVERSATION_ID, rawBody: JSON.stringify({ padding: "x".repeat(310_000) }) }, 413],
  ] as Array<[string, EventOptions, number]>)("rechaza %s", async (_name, options, status) => {
    const result = await save(eventWith(options));

    expect(result.statusCode).toBe(status);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  test("sin identidad de usuario (sub) responde 403 sin escribir", async () => {
    const result = await save(eventWith({ user: null, conversationId: CONVERSATION_ID, body: validBody }));

    expect(result.statusCode).toBe(403);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });
});
