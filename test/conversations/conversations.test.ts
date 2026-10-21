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

import { CONVERSATION_RETENTION_DAYS, deriveTitle, MAX_MESSAGES, MAX_TEXT_LENGTH, MAX_TITLE_LENGTH } from "../../src/conversations/conversationStore";
import { handler as remove } from "../../src/conversations/deleteHandler";
import { handler as get } from "../../src/conversations/getHandler";
import { handler as list } from "../../src/conversations/listHandler";
import { handler as save } from "../../src/conversations/saveHandler";

const CONVERSATION_ID = "2026-10-21T12:00:00.000Z_ab12cd34";

interface EventOptions {
  tenant?: string | null;
  user?: string | null;
  conversationId?: string;
  query?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}

function eventWith({ tenant = "t1", user = "u1", conversationId, query, body, rawBody }: EventOptions = {}): APIGatewayProxyWithCognitoAuthorizerEvent {
  return {
    requestContext: { authorizer: { claims: { ...(tenant ? { "custom:tenantId": tenant } : {}), ...(user ? { sub: user } : {}) } } },
    pathParameters: conversationId ? { conversationId } : null,
    queryStringParameters: query ?? null,
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

describe("GET /assistant/conversations", () => {
  test("consulta las conversaciones de esa persona en ese negocio, de la más nueva a la más vieja", async () => {
    mockDdbSend.mockResolvedValue({ Items: [] });
    await list(eventWith());

    const query = mockDdbSend.mock.calls[0][0].input;
    expect(query.TableName).toBe("TestConversations");
    expect(query.ExpressionAttributeValues).toEqual({ ":pk": "TENANT#t1", ":prefix": "CONV#u1#" });
    expect(query.ScanIndexForward).toBe(false);
    expect(query.Limit).toBe(20);
    // Solo metadata: el hilo no se proyecta.
    expect(query.ProjectionExpression).not.toContain("messages");
  });

  test("devuelve la metadata y descarta las vencidas que DynamoDB todavía no borró", async () => {
    mockDdbSend.mockResolvedValue({
      Items: [
        { conversationId: CONVERSATION_ID, title: "¿Cuánto vendimos hoy?", createdAt: "2026-10-21T12:00:00.000Z", updatedAt: "2026-10-21T12:05:00.000Z", ttl: nowSeconds() + 1000 },
        { conversationId: "2026-09-01T00:00:00.000Z_deadbeef", title: "vieja", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", ttl: nowSeconds() - 10 },
      ],
      LastEvaluatedKey: { pk: "TENANT#t1", sk: `CONV#u1#${CONVERSATION_ID}` },
    });
    const result = await list(eventWith());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.conversations.map((c: { conversationId: string }) => c.conversationId)).toEqual([CONVERSATION_ID]);
    expect(body.conversations[0].title).toBe("¿Cuánto vendimos hoy?");
    expect("messages" in body.conversations[0]).toBe(false);
    expect(body.nextCursor).toEqual(expect.any(String));
  });

  test("respeta el tamaño de página pedido hasta un máximo", async () => {
    mockDdbSend.mockResolvedValue({ Items: [] });
    await list(eventWith({ query: { limit: "5" } }));
    await list(eventWith({ query: { limit: "5000" } }));

    expect(mockDdbSend.mock.calls[0][0].input.Limit).toBe(5);
    expect(mockDdbSend.mock.calls[1][0].input.Limit).toBe(50);
  });

  test("sin identidad de usuario (sub) responde 403 sin consultar la tabla", async () => {
    const result = await list(eventWith({ user: null }));

    expect(result.statusCode).toBe(403);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });
});

describe("GET /assistant/conversations/{conversationId}", () => {
  test("lee con la clave del tenant y del usuario autenticados y devuelve el hilo", async () => {
    mockDdbSend.mockResolvedValue({
      Item: { conversationId: CONVERSATION_ID, title: "t", ...validBody, createdAt: "c", updatedAt: "u", ttl: nowSeconds() + 1000 },
    });
    const result = await get(eventWith({ conversationId: encodeURIComponent(CONVERSATION_ID) }));

    expect(result.statusCode).toBe(200);
    expect(mockDdbSend.mock.calls[0][0].input.Key).toEqual({ pk: "TENANT#t1", sk: `CONV#u1#${CONVERSATION_ID}` });
    const body = JSON.parse(result.body);
    expect(body.messages).toEqual(validBody.messages);
    expect(body.history).toEqual(validBody.history);
  });

  test("una conversación inexistente o vencida da 404", async () => {
    mockDdbSend.mockResolvedValueOnce({});
    expect((await get(eventWith({ conversationId: CONVERSATION_ID }))).statusCode).toBe(404);

    mockDdbSend.mockResolvedValueOnce({ Item: { conversationId: CONVERSATION_ID, ...validBody, ttl: nowSeconds() - 10 } });
    expect((await get(eventWith({ conversationId: CONVERSATION_ID }))).statusCode).toBe(404);
  });

  test("el id de otra persona no se puede leer: la clave sale del sub autenticado", async () => {
    mockDdbSend.mockResolvedValue({});
    await get(eventWith({ user: "otra-persona", conversationId: CONVERSATION_ID }));

    expect(mockDdbSend.mock.calls[0][0].input.Key.sk).toBe(`CONV#otra-persona#${CONVERSATION_ID}`);
  });

  test("un id con formato inválido da 400 sin consultar la tabla", async () => {
    const result = await get(eventWith({ conversationId: "../otra" }));

    expect(result.statusCode).toBe(400);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });
});

describe("DELETE /assistant/conversations/{conversationId}", () => {
  test("borra con la clave del tenant y del usuario autenticados", async () => {
    const result = await remove(eventWith({ conversationId: encodeURIComponent(CONVERSATION_ID) }));

    expect(result.statusCode).toBe(204);
    const del = mockDdbSend.mock.calls[0][0].input;
    expect(del.TableName).toBe("TestConversations");
    expect(del.Key).toEqual({ pk: "TENANT#t1", sk: `CONV#u1#${CONVERSATION_ID}` });
  });

  test("un id con formato inválido da 400 sin tocar la tabla", async () => {
    const result = await remove(eventWith({ conversationId: "../otra" }));

    expect(result.statusCode).toBe(400);
    expect(mockDdbSend).not.toHaveBeenCalled();
  });
});

describe("deriveTitle", () => {
  test("usa el primer mensaje del usuario", () => {
    expect(deriveTitle([{ role: "ai", text: "hola" }, { role: "user", text: "¿Cuánto vendimos?" }, { role: "user", text: "otro" }])).toBe("¿Cuánto vendimos?");
  });

  test("colapsa espacios y saltos de línea", () => {
    expect(deriveTitle([{ role: "user", text: "  ventas\n\n  por   sucursal " }])).toBe("ventas por sucursal");
  });

  test("corta los textos largos con puntos suspensivos", () => {
    const title = deriveTitle([{ role: "user", text: "x".repeat(200) }]);

    expect(title).toBe(`${"x".repeat(MAX_TITLE_LENGTH)}…`);
  });

  test("sin mensaje de usuario usa un título genérico", () => {
    expect(deriveTitle([{ role: "ai", text: "hola" }])).toBe("Conversación");
  });
});

describe("PUT /assistant/conversations/{conversationId}", () => {
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
    // La fecha de creación y el título se conservan en los guardados siguientes.
    expect(update.UpdateExpression).toContain("createdAt = if_not_exists(createdAt, :now)");
    expect(update.UpdateExpression).toContain("title = if_not_exists(title, :title)");
    expect(update.ExpressionAttributeValues[":title"]).toBe("¿Cuánto vendimos hoy?");
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
