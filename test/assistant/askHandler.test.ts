import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

const mockBedrockSend = jest.fn();
const mockDdbSend = jest.fn();
const mockRunAthenaQuery = jest.fn();

jest.mock("../../src/shared/auth", () => ({
  resolveActiveTenantIdFromEvent: async (event: APIGatewayProxyWithCognitoAuthorizerEvent) => event.requestContext.authorizer.claims["custom:tenantId"],
}));

jest.mock("@aws-sdk/client-bedrock-runtime", () => {
  const actual = jest.requireActual("@aws-sdk/client-bedrock-runtime");
  return {
    ...actual,
    BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: (...args: unknown[]) => mockBedrockSend(...args) })),
  };
});
jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, TICKETS_TABLE: "TestTickets", AGENTS_TABLE: "TestAgents" };
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

test("recorta respuestas largas del asistente en history en vez de rechazarlas", async () => {
  mockBedrockSend.mockResolvedValue(textResponse("ok"));
  const history = [
    { role: "user", text: "analizame los productos" },
    { role: "assistant", text: "x".repeat(3000) },
  ];
  const result = await handler(eventWith({ question: "ponmelo en un reporte", history }));
  expect(result.statusCode).toBe(200);
  expect(mockBedrockSend.mock.calls[0][0].input.messages[1].content[0].text).toHaveLength(2000);
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
  // El asistente pide menos categorías que un widget (tokens de entrada a Bedrock).
  expect(sql).toMatch(/LIMIT 50$/);
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

test("run_widget_query: ofrece y acepta agrupar por día (\"¿qué día vendí más?\")", async () => {
  mockBedrockSend
    .mockResolvedValueOnce(
      toolUseResponse("tu1", "run_widget_query", { field: "total", aggregation: "sum", groupBy: "day" }),
    )
    .mockResolvedValueOnce(textResponse("El día que más vendiste fue el 2026-09-12, con $85.000."));
  mockRunAthenaQuery.mockResolvedValue([
    { label: "2026-09-11", value: 40000 },
    { label: "2026-09-12", value: 85000 },
  ]);

  const result = await handler(eventWith({ question: "¿qué día tenemos mayor ventas?" }, "tenant-x"));

  expect(result.statusCode).toBe(200);
  const tools = mockBedrockSend.mock.calls[0][0].input.toolConfig.tools;
  const widgetTool = tools.find((t: { toolSpec: { name: string } }) => t.toolSpec.name === "run_widget_query");
  expect(widgetTool.toolSpec.inputSchema.json.properties.groupBy.enum).toContain("day");

  const [sql] = mockRunAthenaQuery.mock.calls[0];
  expect(sql).toContain("substr(capturedat, 1, 10)");
  const toolResultMsg = mockBedrockSend.mock.calls[1][0].input.messages[2];
  expect(toolResultMsg.content[0].toolResult.status).toBeUndefined();
});

test("run_widget_query: agrupado por producto, cada fila trae el volumen del nombre", async () => {
  mockBedrockSend
    .mockResolvedValueOnce(
      toolUseResponse("tu1", "run_widget_query", { field: "quantity", aggregation: "sum", groupBy: "description" }),
    )
    .mockResolvedValueOnce(textResponse("Listo."));
  mockRunAthenaQuery.mockResolvedValue([
    { label: "AGUA TRATADA 350 ML SIN GAS", value: 40 },
    { label: "CASINO Y RESTAURANTE SERV DE COMEDOR", value: 2 },
  ]);

  await handler(eventWith({ question: "tabla de envases vendidos con el volumen" }, "tenant-x"));

  const toolResultMsg = mockBedrockSend.mock.calls[1][0].input.messages[2];
  const data = toolResultMsg.content[0].toolResult.content[0].json.data;
  expect(data[0]).toMatchObject({ label: "AGUA TRATADA 350 ML SIN GAS", value: 40, volume: "350 ML" });
  expect(data[1].volume).toBeUndefined();
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

test("list_tickets: devuelve cliente y número de factura de las facturas electrónicas", async () => {
  mockBedrockSend
    .mockResolvedValueOnce(toolUseResponse("tu1", "list_tickets", {}))
    .mockResolvedValueOnce(textResponse("Listo."));
  mockDdbSend.mockResolvedValue({
    Items: [
      { ticketId: "a", capturedAt: "2026-08-01T00:00:00Z", status: "parsed", port: "UBL", total: 100, customerName: "ACME SAS", customerId: "900123", documentNumber: "FVA1", docType: "sale" },
      { ticketId: "b", capturedAt: "2026-08-02T00:00:00Z", status: "parsed", port: "COM3", total: 50 },
    ],
  });

  await handler(eventWith({ question: "listame las ventas con el cliente" }, "tenant-x"));

  const toolResultMsg = mockBedrockSend.mock.calls[1][0].input.messages[2];
  const payload = JSON.parse(toolResultMsg.content[0].toolResult.content[0].text ?? JSON.stringify(toolResultMsg.content[0].toolResult.content[0].json));
  expect(payload.tickets[0]).toMatchObject({ customerName: "ACME SAS", customerId: "900123", documentNumber: "FVA1" });
  expect(payload.tickets[1].customerName).toBeUndefined();
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
    toolCalls: [],
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
  expect(entries[0]).toMatchObject({
    toolCalls: [{ name: "run_widget_query", input: { field: "total", aggregation: "sum" } }],
    turns: 2,
    historyTurns: 2,
  });
  expect((entries[0].toolCalls as Array<Record<string, unknown>>)[0]).not.toHaveProperty("error");
});

test("logQa: registra el input y el error de cada herramienta que falló", async () => {
  // Reproduce el caso real del 2026-10-16 ("ventas de octubre, lo q diga
  // horneadas"): un intento rechazado por validación y otro que falla en
  // Athena, antes de que el modelo conteste sin datos.
  mockBedrockSend
    .mockResolvedValueOnce(
      toolUseResponse("tu1", "run_widget_query", { field: "total", aggregation: "sum", groupBy: "description" }),
    )
    .mockResolvedValueOnce(
      toolUseResponse("tu2", "run_widget_query", {
        field: "subtotal",
        aggregation: "sum",
        groupBy: "description",
        filters: { dateFrom: "2026-10-01", dateTo: "2026-10-31" },
      }),
    )
    .mockResolvedValueOnce(textResponse("Hubo un problema técnico al consultar los datos."));
  mockRunAthenaQuery.mockRejectedValue(new Error("la consulta de Athena falló: TYPE_MISMATCH"));
  const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

  await handler(eventWith({ question: "Ventas de octubre por horneadas y empanadas" }, "tenant-log"));
  consoleErrorSpy.mockRestore();

  const entries = qaLogEntries();
  expect(entries).toHaveLength(1);
  expect(entries[0].turns).toBe(3);
  expect(entries[0].toolCalls).toEqual([
    {
      name: "run_widget_query",
      input: { field: "total", aggregation: "sum", groupBy: "description" },
      error: expect.stringContaining("no se puede agrupar"),
    },
    {
      name: "run_widget_query",
      input: {
        field: "subtotal",
        aggregation: "sum",
        groupBy: "description",
        filters: { dateFrom: "2026-10-01", dateTo: "2026-10-31" },
      },
      error: "la consulta de Athena falló: TYPE_MISMATCH",
    },
  ]);
});

test("run_widget_query: descriptionContains (\"lo que diga horneadas\") llega al SQL como parámetro", async () => {
  mockBedrockSend
    .mockResolvedValueOnce(
      toolUseResponse("tu1", "run_widget_query", {
        field: "subtotal",
        aggregation: "sum",
        filters: { dateFrom: "2026-10-01", dateTo: "2026-10-31", descriptionContains: "  horne  " },
      }),
    )
    .mockResolvedValueOnce(textResponse("En octubre vendiste $396.343 en horneadas."));
  mockRunAthenaQuery.mockResolvedValue([{ value: 396343 }]);

  const result = await handler(eventWith({ question: "Ventas de octubre de horneadas" }, "tenant-x"));

  expect(result.statusCode).toBe(200);
  const [sql, params] = mockRunAthenaQuery.mock.calls[0];
  expect(sql).toContain("strpos(lower(description), lower(?)) > 0");
  expect(params).toEqual(["tenant-x", "2026", "2026", "2026-10-01", "2026-10-31T23:59:59.999Z", "horne"]);
});

test("el prompt lleva la fecha de hoy (sin ella el modelo preguntaba \"¿octubre de qué año?\")", async () => {
  mockBedrockSend.mockResolvedValue(textResponse("ok"));
  await handler(eventWith({ question: "hola" }));
  const systemText = mockBedrockSend.mock.calls[0][0].input.system[0].text as string;
  expect(systemText).toContain(`Hoy es ${new Date().toISOString().slice(0, 10)}`);
  expect(systemText).toContain("No pidas aclaraciones");
});

test("el prompt le indica al modelo qué hacer cuando una herramienta falla", async () => {
  mockBedrockSend.mockResolvedValue(textResponse("ok"));
  await handler(eventWith({ question: "hola" }));
  const systemText = mockBedrockSend.mock.calls[0][0].input.system[0].text as string;
  expect(systemText).toContain("Si una herramienta devuelve un error");
  expect(systemText).toContain("problema técnico");
});

test("logQa: no registra nada cuando el request se rechaza antes de llegar a Bedrock", async () => {
  await handler(eventWith({ question: "hola" }, ""));
  await handler(eventWith({}));
  mockDdbSend.mockRejectedValueOnce(new ConditionalCheckFailedException({ message: "límite", $metadata: {} }));
  await handler(eventWith({ question: "hola" }, "tenant-x"));

  expect(qaLogEntries()).toHaveLength(0);
});

test("build_report: ejecuta una consulta por sección y devuelve el reporte con datos reales", async () => {
  mockBedrockSend
    .mockResolvedValueOnce(
      toolUseResponse("tu1", "build_report", {
        title: "Ventas de octubre",
        sections: [
          { heading: "Total", field: "total", aggregation: "sum", filters: { dateFrom: "2026-10-01" } },
          { heading: "Por robot", field: "total", aggregation: "sum", groupBy: "port" },
        ],
      }),
    )
    .mockResolvedValueOnce(textResponse("Reporte listo: COM3 lidera."));
  mockRunAthenaQuery
    .mockResolvedValueOnce([{ value: 20000 }])
    .mockResolvedValueOnce([{ label: "COM3", value: 12000 }]);

  const result = await handler(eventWith({ question: "hazme un reporte de octubre" }, "tenant-x"));

  expect(result.statusCode).toBe(200);
  const body = JSON.parse(result.body);
  expect(body.answer).toBe("Reporte listo: COM3 lidera.");
  expect(body.report.title).toBe("Ventas de octubre");
  expect(body.report.sections.map((s: { heading: string }) => s.heading)).toEqual(["Total", "Por robot"]);
  expect(body.report.sections[1].data).toEqual([{ label: "COM3", value: 12000 }]);
  // Ambas consultas llevan el tenant del JWT.
  expect(mockRunAthenaQuery).toHaveBeenCalledTimes(2);
  for (const [, params] of mockRunAthenaQuery.mock.calls) expect(params[0]).toBe("tenant-x");
});

test("build_report: una sección inválida hace fallar la herramienta y no se devuelve reporte", async () => {
  mockBedrockSend
    .mockResolvedValueOnce(
      toolUseResponse("tu1", "build_report", {
        title: "X",
        sections: [{ heading: "Mala", field: "inventado", aggregation: "sum" }],
      }),
    )
    .mockResolvedValueOnce(textResponse("Hubo un problema técnico."));

  const result = await handler(eventWith({ question: "reporte" }, "tenant-x"));

  expect(JSON.parse(result.body).report).toBeUndefined();
  const toolResult = mockBedrockSend.mock.calls[1][0].input.messages[2].content[0].toolResult;
  expect(toolResult.status).toBe("error");
  expect(toolResult.content[0].text).toContain("sections[0]");
  expect(mockRunAthenaQuery).not.toHaveBeenCalled();
});

test("build_report: rechaza más secciones que el tope", async () => {
  const sections = Array.from({ length: 7 }, (_, i) => ({ heading: `S${i}`, field: "total", aggregation: "sum" }));
  mockBedrockSend
    .mockResolvedValueOnce(toolUseResponse("tu1", "build_report", { title: "X", sections }))
    .mockResolvedValueOnce(textResponse("ok"));

  await handler(eventWith({ question: "reporte" }, "tenant-x"));

  expect(mockRunAthenaQuery).not.toHaveBeenCalled();
  expect(mockBedrockSend.mock.calls[1][0].input.messages[2].content[0].toolResult.status).toBe("error");
});

test("build_report: deduce el tipo de sección y compara el KPI con el periodo anterior", async () => {
  mockBedrockSend
    .mockResolvedValueOnce(
      toolUseResponse("tu1", "build_report", {
        title: "Octubre",
        sections: [
          { heading: "Ventas", field: "total", aggregation: "sum", filters: { dateFrom: "2026-10-01", dateTo: "2026-10-31" } },
          { heading: "Por día", field: "total", aggregation: "sum", groupBy: "day" },
          { heading: "Por producto", field: "subtotal", aggregation: "sum", groupBy: "description" },
        ],
      }),
    )
    .mockResolvedValueOnce(textResponse("listo"));
  mockRunAthenaQuery.mockImplementation(async (_sql: string, params: string[]) =>
    // El periodo anterior de octubre (31 días) es 2026-08-31 .. 2026-09-30.
    params.includes("2026-08-31") ? [{ value: 800 }] : [{ value: 1000 }],
  );

  const result = await handler(eventWith({ question: "reporte de octubre" }, "tenant-x"));

  const { report } = JSON.parse(result.body);
  expect(report.sections.map((s: { kind: string }) => s.kind)).toEqual(["kpi", "trend", "ranking"]);
  expect(report.sections[0].previous).toBe(800);
  expect(report.sections[1].previous).toBeUndefined();
  expect(mockRunAthenaQuery).toHaveBeenCalledTimes(4);
});

test("build_report conserva ausencia del periodo anterior sin inventar cero", async () => {
  mockBedrockSend
    .mockResolvedValueOnce(toolUseResponse("tu1", "build_report", {
      title: "Sin base",
      sections: [{ heading: "Ticket medio", field: "total", aggregation: "avg", filters: { dateFrom: "2026-10-01", dateTo: "2026-10-31" } }],
    }))
    .mockResolvedValueOnce(textResponse("No hay base anterior."));
  mockRunAthenaQuery.mockResolvedValueOnce([{ value: 10.9, sampleCount: 100 }]).mockResolvedValueOnce([{ value: null, sampleCount: 0 }]);
  const result = await handler(eventWith({ question: "reporte octubre" }));
  const section = JSON.parse(result.body).report.sections[0];
  expect(section.data).toEqual([{ value: 10.9, sampleCount: 100 }]);
  expect(section.previous).toBeNull();
});

test.each([
  null, [], "hoy", { dateFrom: "2026-02-31" },
  { dateFrom: "2026-10-31", dateTo: "2026-10-01" }, { port: 12 }, { status: "inexistente" }, { descriptionContains: 12 },
])("run_widget_query rechaza filtros ambiguos o inválidos: %j", async (filters) => {
  mockBedrockSend
    .mockResolvedValueOnce(toolUseResponse("tu1", "run_widget_query", { field: "total", aggregation: "sum", filters }))
    .mockResolvedValueOnce(textResponse("Debo corregir los filtros."));
  await handler(eventWith({ question: "ventas" }));
  expect(mockRunAthenaQuery).not.toHaveBeenCalled();
  const messages = mockBedrockSend.mock.calls[1][0].input.messages;
  expect(messages[2].content[0].toolResult.status).toBe("error");
});

test("run_widget_query por agent: traduce los agentId al nombre de la sucursal (etiqueta de ubicación)", async () => {
  mockBedrockSend
    .mockResolvedValueOnce(toolUseResponse("tu1", "run_widget_query", { field: "total", aggregation: "sum", groupBy: "agent" }))
    .mockResolvedValueOnce(textResponse("Vendió más Sol."));
  mockRunAthenaQuery.mockResolvedValue([
    { label: "agent-sol", value: 3426.94 },
    { label: "agent-sin-ubicacion", value: 900 },
    { label: "(sin dato)", value: 12 },
  ]);
  mockDdbSend.mockImplementation(async (cmd: { input: { TableName?: string } }) =>
    cmd.input.TableName === "TestAgents"
      ? {
          Items: [
            { agentId: "agent-sol", name: "TPV Sol", location: { label: "Horno Castizo · Sol" } },
            { agentId: "agent-sin-ubicacion", name: "TPV Nuevo" },
          ],
        }
      : {},
  );

  const result = await handler(eventWith({ question: "¿qué sucursal vendió más?" }, "tenant-x"));

  expect(result.statusCode).toBe(200);
  const agentsQuery = mockDdbSend.mock.calls.map(([cmd]) => cmd.input).find((input) => input.ExpressionAttributeValues?.[":prefix"] === "AGENT#");
  expect(agentsQuery.ExpressionAttributeValues[":pk"]).toBe("TENANT#tenant-x");
  const toolResultMsg = mockBedrockSend.mock.calls[1][0].input.messages[2];
  expect(toolResultMsg.content[0].toolResult.content[0].json.data).toEqual([
    { label: "Horno Castizo · Sol", value: 3426.94 },
    { label: "TPV Nuevo", value: 900 },
    { label: "Sin sucursal asignada", value: 12 },
  ]);
});

test("run_widget_query por agent: si no se pueden leer las sucursales, sigue funcionando con los ids", async () => {
  mockBedrockSend
    .mockResolvedValueOnce(toolUseResponse("tu1", "run_widget_query", { field: "total", aggregation: "sum", groupBy: "agent" }))
    .mockResolvedValueOnce(textResponse("ok"));
  mockRunAthenaQuery.mockResolvedValue([{ label: "agent-sol", value: 10 }]);
  const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  mockDdbSend.mockImplementation(async (cmd: { input: { ExpressionAttributeValues?: Record<string, unknown> } }) => {
    if (cmd.input.ExpressionAttributeValues?.[":prefix"] === "AGENT#") throw new Error("boom");
    return {};
  });

  const result = await handler(eventWith({ question: "¿qué sucursal vendió más?" }, "tenant-x"));

  expect(result.statusCode).toBe(200);
  const toolResultMsg = mockBedrockSend.mock.calls[1][0].input.messages[2];
  expect(toolResultMsg.content[0].toolResult.content[0].json.data).toEqual([{ label: "agent-sol", value: 10 }]);
  errorSpy.mockRestore();
});

test("el prompt manda agrupar por agent para 'sucursal' y no por port, sin símbolo de moneda y con solo negrita como markdown", async () => {
  mockBedrockSend.mockResolvedValueOnce(textResponse("hola"));
  await handler(eventWith({ question: "hola" }));
  const system = mockBedrockSend.mock.calls[0][0].input.system[0].text as string;
  expect(system).toContain('agrupá por "agent"');
  expect(system).toContain('NO uses "port"');
  expect(system).toContain("**negrita**");
  expect(system).toContain("No pongas símbolo de moneda");
});
