import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

const mockBedrockSend = jest.fn();
const mockDdbSend = jest.fn();
const mockRunAthenaQuery = jest.fn();

jest.mock("@aws-sdk/client-bedrock-runtime", () => {
  const actual = jest.requireActual("@aws-sdk/client-bedrock-runtime");
  return {
    ...actual,
    BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: (...args: unknown[]) => mockBedrockSend(...args) })),
  };
});
jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, TICKETS_TABLE: "TestTickets" };
});
jest.mock("../../src/widgets/athenaQuery", () => ({
  runWidgetQuery: (...args: unknown[]) => mockRunAthenaQuery(...args),
}));

import { handler } from "../../src/assistant/askHandler";

function eventWith(body: unknown, tenantId = "t1"): APIGatewayProxyWithCognitoAuthorizerEvent {
  return {
    requestContext: { authorizer: { claims: tenantId ? { "custom:tenantId": tenantId } : {} } },
    body: body === undefined ? null : JSON.stringify(body),
  } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;
}

function textResponse(text: string) {
  return { stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text }] } } };
}

function toolUseResponse(toolUseId: string, name: string, input: unknown) {
  return {
    stopReason: "tool_use",
    output: { message: { role: "assistant", content: [{ toolUse: { toolUseId, name, input } }] } },
  };
}

let consoleLogSpy: jest.SpyInstance;

beforeEach(() => {
  mockBedrockSend.mockReset();
  mockDdbSend.mockReset();
  mockRunAthenaQuery.mockReset();
  process.env.BEDROCK_MODEL_ID = "test-model";
  process.env.ATHENA_WORKGROUP = "test-wg";
  process.env.ASSISTANT_USAGE_TABLE = "test-usage";
  // Por defecto, las dos escrituras de rate limit (minuto + día) pasan —
  // los tests que quieran probar el 429 lo sobreescriben explícitamente.
  mockDdbSend.mockResolvedValue({});
  consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  consoleLogSpy.mockRestore();
});

/** Entradas de log de auditoría (logQa) — ignora cualquier otro console.log incidental. */
function qaLogEntries(): Array<Record<string, unknown>> {
  return consoleLogSpy.mock.calls
    .map(([arg]) => arg as string)
    .filter((arg) => typeof arg === "string")
    .map((arg) => {
      try {
        return JSON.parse(arg) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((parsed): parsed is Record<string, unknown> => parsed?.event === "assistant_qa");
}

test("rechaza sin tenant autenticado", async () => {
  const result = await handler(eventWith({ question: "hola" }, ""));
  expect(result.statusCode).toBe(403);
  expect(mockBedrockSend).not.toHaveBeenCalled();
});

test("rechaza body sin question", async () => {
  const result = await handler(eventWith({}));
  expect(result.statusCode).toBe(400);
  expect(mockBedrockSend).not.toHaveBeenCalled();
});

test("history: se antepone a la pregunta nueva en el orden correcto", async () => {
  mockBedrockSend.mockResolvedValue(textResponse("Por producto, lo más vendido fue Pizza."));

  const result = await handler(
    eventWith({
      question: "¿y por producto?",
      history: [
        { role: "user", text: "¿cuánto vendí?" },
        { role: "assistant", text: "Vendiste $12.000 en total." },
      ],
    }),
  );

  expect(result.statusCode).toBe(200);
  // Índices fijos, no el array completo: para cuando el test lee esto, el
  // mismo array (por referencia) ya tiene además la respuesta final del
  // turno único empujada atrás — ver el comentario equivalente más abajo.
  const sentMessages = mockBedrockSend.mock.calls[0][0].input.messages;
  expect(sentMessages[0]).toEqual({ role: "user", content: [{ text: "¿cuánto vendí?" }] });
  expect(sentMessages[1]).toEqual({ role: "assistant", content: [{ text: "Vendiste $12.000 en total." }] });
  expect(sentMessages[2]).toEqual({ role: "user", content: [{ text: "¿y por producto?" }] });
});

test("history vacía o ausente no rompe nada (comportamiento previo intacto)", async () => {
  mockBedrockSend.mockResolvedValue(textResponse("ok"));
  const result = await handler(eventWith({ question: "hola", history: [] }));
  expect(result.statusCode).toBe(200);
  expect(mockBedrockSend.mock.calls[0][0].input.messages[0]).toEqual({ role: "user", content: [{ text: "hola" }] });
});

test("rechaza history que no alterna user/assistant empezando por user", async () => {
  const result = await handler(
    eventWith({ question: "hola", history: [{ role: "assistant", text: "no debería ir primero" }] }),
  );
  expect(result.statusCode).toBe(400);
  expect(mockBedrockSend).not.toHaveBeenCalled();
});

test("rechaza history más larga que el tope", async () => {
  const history = Array.from({ length: 7 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    text: `mensaje ${i}`,
  }));
  const result = await handler(eventWith({ question: "hola", history }));
  expect(result.statusCode).toBe(400);
  expect(mockBedrockSend).not.toHaveBeenCalled();
});

test("rechaza un mensaje de history vacío", async () => {
  const result = await handler(eventWith({ question: "hola", history: [{ role: "user", text: "   " }] }));
  expect(result.statusCode).toBe(400);
  expect(mockBedrockSend).not.toHaveBeenCalled();
});

test("rechaza question demasiado larga", async () => {
  const result = await handler(eventWith({ question: "a".repeat(501) }));
  expect(result.statusCode).toBe(400);
  expect(mockBedrockSend).not.toHaveBeenCalled();
});

test("responde directo cuando el modelo no necesita ninguna herramienta", async () => {
  mockBedrockSend.mockResolvedValue(textResponse("Todavía estoy en construcción."));

  const result = await handler(eventWith({ question: "¿qué podés hacer?" }));

  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body).answer).toBe("Todavía estoy en construcción.");
  expect(mockBedrockSend).toHaveBeenCalledTimes(1);
});

test("502 si Bedrock no devuelve texto", async () => {
  mockBedrockSend.mockResolvedValue({ output: { message: { content: [] } } });
  const result = await handler(eventWith({ question: "hola" }));
  expect(result.statusCode).toBe(502);
});

test("502 si Bedrock falla", async () => {
  mockBedrockSend.mockRejectedValue(new Error("boom"));
  const result = await handler(eventWith({ question: "hola" }));
  expect(result.statusCode).toBe(502);
});

test("run_widget_query: ejecuta la consulta real y responde con el resultado", async () => {
  mockBedrockSend
    .mockResolvedValueOnce(
      toolUseResponse("tu1", "run_widget_query", { field: "total", aggregation: "sum", groupBy: "port" }),
    )
    .mockResolvedValueOnce(textResponse("El robot COM3 vendió más, con $12.000 en total."));
  mockRunAthenaQuery.mockResolvedValue([{ label: "COM3", value: 12000 }]);

  const result = await handler(eventWith({ question: "¿qué robot vendió más?" }, "tenant-x"));

  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body).answer).toBe("El robot COM3 vendió más, con $12.000 en total.");
  expect(mockBedrockSend).toHaveBeenCalledTimes(2);

  // La consulta se armó con el tenant real (del JWT, no de lo que mande el modelo).
  expect(mockRunAthenaQuery).toHaveBeenCalledTimes(1);
  const [sql, params] = mockRunAthenaQuery.mock.calls[0];
  expect(sql).toContain("ticket_items");
  expect(params[0]).toBe("tenant-x");

  // El segundo turno le manda al modelo el resultado real de la herramienta.
  // Índice fijo (no .at(-1)): el array de mensajes es el mismo objeto por
  // referencia en los mocks, y para cuando el test corre ya tiene además el
  // mensaje final del turno 2 empujado atrás.
  const secondCallInput = mockBedrockSend.mock.calls[1][0].input;
  const toolResultMsg = secondCallInput.messages[2];
  expect(toolResultMsg.content[0].toolResult.toolUseId).toBe("tu1");
  expect(toolResultMsg.content[0].toolResult.content[0].json.data).toEqual([{ label: "COM3", value: 12000 }]);
});

test("list_tickets: consulta DynamoDB por estado y limita el resultado", async () => {
  mockBedrockSend
    .mockResolvedValueOnce(toolUseResponse("tu1", "list_tickets", { status: "failed", limit: 5 }))
    .mockResolvedValueOnce(textResponse("Tenés 2 tickets fallidos recientes."));
  mockDdbSend.mockResolvedValue({
    Items: [
      { ticketId: "a", capturedAt: "2026-08-01T00:00:00Z", status: "failed", port: "COM3", total: undefined },
      { ticketId: "b", capturedAt: "2026-08-02T00:00:00Z", status: "failed", port: "COM3", total: undefined },
    ],
  });

  const result = await handler(eventWith({ question: "¿tengo tickets fallidos?" }, "tenant-x"));

  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body).answer).toBe("Tenés 2 tickets fallidos recientes.");
  // Entre las llamadas a ddb también están las dos escrituras de rate limit
  // (minuto + día) — se busca la que es la consulta real, no un índice fijo.
  const ddbInput = mockDdbSend.mock.calls.map(([cmd]) => cmd.input).find((input) => input.IndexName === "status-index");
  expect(ddbInput).toBeDefined();
  expect(ddbInput.ExpressionAttributeValues[":gsi1pk"]).toBe("TENANT#tenant-x#STATUS#failed");
  expect(ddbInput.Limit).toBe(5);
});

test("429 si el tenant supera el límite de preguntas por minuto: no llama a Bedrock", async () => {
  mockDdbSend.mockRejectedValueOnce(new ConditionalCheckFailedException({ message: "límite", $metadata: {} }));

  const result = await handler(eventWith({ question: "hola" }, "tenant-x"));

  expect(result.statusCode).toBe(429);
  expect(JSON.parse(result.body).error).toContain("rápido");
  expect(mockBedrockSend).not.toHaveBeenCalled();
});

test("429 si el tenant supera el límite diario (pasó el de minuto)", async () => {
  mockDdbSend
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new ConditionalCheckFailedException({ message: "límite", $metadata: {} }));

  const result = await handler(eventWith({ question: "hola" }, "tenant-x"));

  expect(result.statusCode).toBe(429);
  expect(JSON.parse(result.body).error).toContain("límite de preguntas de hoy");
  expect(mockBedrockSend).not.toHaveBeenCalled();
});

test("un campo inválido pedido por el modelo no llega a Athena: se le devuelve el error como toolResult", async () => {
  mockBedrockSend
    .mockResolvedValueOnce(toolUseResponse("tu1", "run_widget_query", { field: "no-existe", aggregation: "sum" }))
    .mockResolvedValueOnce(textResponse("No pude calcular eso, ¿podés reformular la pregunta?"));

  const result = await handler(eventWith({ question: "algo raro" }, "tenant-x"));

  expect(result.statusCode).toBe(200);
  expect(mockRunAthenaQuery).not.toHaveBeenCalled();
  const secondCallInput = mockBedrockSend.mock.calls[1][0].input;
  const toolResult = secondCallInput.messages[2].content[0].toolResult;
  expect(toolResult.status).toBe("error");
  expect(toolResult.content[0].text).toContain("campo inválido");
});

test("herramienta desconocida no rompe el flujo, se reporta como error al modelo", async () => {
  mockBedrockSend
    .mockResolvedValueOnce(toolUseResponse("tu1", "delete_everything", {}))
    .mockResolvedValueOnce(textResponse("No tengo esa capacidad."));

  const result = await handler(eventWith({ question: "borrá todo" }, "tenant-x"));

  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body).answer).toBe("No tengo esa capacidad.");
});

test("si el modelo insiste con tool_use más allá del tope de turnos, corta con 502", async () => {
  mockBedrockSend.mockResolvedValue(toolUseResponse("tu1", "list_tickets", {}));
  mockDdbSend.mockResolvedValue({ Items: [] });

  const result = await handler(eventWith({ question: "loop" }, "tenant-x"));

  expect(result.statusCode).toBe(502);
});

test("logQa: registra pregunta+respuesta cuando el modelo no usa herramientas", async () => {
  mockBedrockSend.mockResolvedValue(textResponse("Todo bien."));

  await handler(eventWith({ question: "¿cómo estás?" }, "tenant-log"));

  const entries = qaLogEntries();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    tenantId: "tenant-log",
    question: "¿cómo estás?",
    answer: "Todo bien.",
    toolsUsed: [],
    turns: 1,
    historyTurns: 0,
  });
  expect(typeof entries[0].timestamp).toBe("string");
});

test("logQa: registra qué herramientas se usaron y cuántos turnos hicieron falta", async () => {
  mockBedrockSend
    .mockResolvedValueOnce(toolUseResponse("tu1", "run_widget_query", { field: "total", aggregation: "sum" }))
    .mockResolvedValueOnce(textResponse("Vendiste $500."));
  mockRunAthenaQuery.mockResolvedValue([{ value: 500 }]);

  await handler(
    eventWith(
      { question: "¿cuánto vendí?", history: [{ role: "user", text: "hola" }, { role: "assistant", text: "hola!" }] },
      "tenant-log",
    ),
  );

  const entries = qaLogEntries();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ toolsUsed: ["run_widget_query"], turns: 2, historyTurns: 2 });
});

test("logQa: no registra nada cuando el request se rechaza antes de llegar a Bedrock", async () => {
  await handler(eventWith({ question: "hola" }, ""));
  await handler(eventWith({}));
  mockDdbSend.mockRejectedValueOnce(new ConditionalCheckFailedException({ message: "límite", $metadata: {} }));
  await handler(eventWith({ question: "hola" }, "tenant-x"));

  expect(qaLogEntries()).toHaveLength(0);
});
