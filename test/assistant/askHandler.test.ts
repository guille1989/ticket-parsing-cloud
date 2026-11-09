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
  return {
    ...actual,
    ddb: { send: (...args: unknown[]) => mockDdbSend(...args) },
    TICKETS_TABLE: "TestTickets",
    AGENTS_TABLE: "TestAgents",
    MATTERS_TABLE: "TestMatters",
    WIDGETS_TABLE: "TestWidgets",
  };
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
  expect(sql).toContain("strpos(regexp_replace(normalize(lower(description), NFD)");
  expect(params).toEqual(["tenant-x", "2026", "2026", "2026-10-01", "2026-10-31T23:59:59.999Z", "horne"]);
});

describe("horas pico", () => {
  test("el prompt manda agrupar por hourOfDay (no por hour) y a no inventar patrones fuera de las filas", async () => {
    mockBedrockSend.mockResolvedValue(textResponse("ok"));
    await handler(eventWith({ question: "hola" }));

    const systemText = mockBedrockSend.mock.calls[0][0].input.system[0].text as string;
    expect(systemText).toContain('agrupá por "hourOfDay"');
    expect(systemText).toContain('NUNCA uses "hour" ni "day" para esto');
    expect(systemText).toContain("no inventes patrones");
  });

  test("la herramienta ofrece hourOfDay y weekday, y avisa que hour/day son una fila por fecha", async () => {
    mockBedrockSend.mockResolvedValue(textResponse("ok"));
    await handler(eventWith({ question: "hola" }));

    const tools = mockBedrockSend.mock.calls[0][0].input.toolConfig.tools as Array<{ toolSpec: { name: string; inputSchema: { json: any } } }>;
    const query = tools.find((t) => t.toolSpec.name === "run_widget_query")!.toolSpec.inputSchema.json.properties.groupBy;
    expect(query.enum).toEqual(expect.arrayContaining(["hourOfDay", "weekday", "hour", "day"]));
    expect(query.description).toContain("UNA FILA POR CADA FECHA/HORA");
  });

  test("groupBy hour con cientos de filas: el resultado trae una nota que manda a hourOfDay y a no sumar a mano", async () => {
    mockBedrockSend
      .mockResolvedValueOnce(toolUseResponse("tu1", "run_widget_query", { field: "total", aggregation: "sum", groupBy: "hour" }))
      .mockResolvedValueOnce(textResponse("ok"));
    mockRunAthenaQuery.mockResolvedValue(Array.from({ length: 264 }, (_, i) => ({ label: `2026-09-${String((i % 28) + 1).padStart(2, "0")} ${String(i % 24).padStart(2, "0")}`, value: 100 })));

    await handler(eventWith({ question: "horas pico" }));

    const toolResult = mockBedrockSend.mock.calls[1][0].input.messages[2].content[0].toolResult;
    const payload = toolResult.content[0].json ?? JSON.parse(toolResult.content[0].text);
    expect(payload.note).toContain("Son 264 filas");
    expect(payload.note).toContain('groupBy "hourOfDay"');
    expect(payload.note).toContain("NO las sumes");
  });

  test("groupBy hour con pocas filas (un día) o hourOfDay: sin nota", async () => {
    mockBedrockSend
      .mockResolvedValueOnce(toolUseResponse("tu1", "run_widget_query", { field: "total", aggregation: "sum", groupBy: "hour", filters: { dateFrom: "2026-11-05", dateTo: "2026-11-05" } }))
      .mockResolvedValueOnce(textResponse("ok"));
    mockRunAthenaQuery.mockResolvedValue([{ label: "2026-11-05 11", value: 9500 }]);

    await handler(eventWith({ question: "hoy por hora" }));

    const toolResult = mockBedrockSend.mock.calls[1][0].input.messages[2].content[0].toolResult;
    const payload = toolResult.content[0].json ?? JSON.parse(toolResult.content[0].text);
    expect(payload.note).toBeUndefined();
  });

  test("el prompt aclara que 'horas pico de un día' es un día típico, con el período cubierto y las horas en orden", async () => {
    mockBedrockSend.mockResolvedValue(textResponse("ok"));
    await handler(eventWith({ question: "hola" }));

    const systemText = mockBedrockSend.mock.calls[0][0].input.system[0].text as string;
    expect(systemText).toContain("es un día típico");
    expect(systemText).toContain("qué período cubre la tabla");
    expect(systemText).toContain("de menor a mayor (de cuando abre a cuando cierra)");
    expect(systemText).toContain("no omitas ni repitas filas");
  });

  test("run_widget_query con groupBy hourOfDay llega al SQL en la zona del negocio, una fila por hora del día", async () => {
    mockBedrockSend
      .mockResolvedValueOnce(toolUseResponse("tu1", "run_widget_query", { field: "total", aggregation: "sum", groupBy: "hourOfDay" }))
      .mockResolvedValueOnce(textResponse("La hora pico es 17:00."));
    mockRunAthenaQuery.mockResolvedValue([{ label: "16", value: 100 }, { label: "17", value: 300 }]);

    const result = await handler(eventWith({ question: "horas pico", timeZone: "America/Bogota" }, "tenant-x"));

    expect(result.statusCode).toBe(200);
    const sql = mockRunAthenaQuery.mock.calls[0][0] as string;
    expect(sql).toContain("'America/Bogota'), 'HH')");
    expect(sql).toContain("ORDER BY label ASC");
  });
});

describe("zona horaria del negocio", () => {
  /** El tenant se lee con un GetCommand; las escrituras (rate limit) siguen devolviendo {}. */
  function mockTenant(tenant: Record<string, unknown> | undefined) {
    mockDdbSend.mockImplementation(async (command: { constructor: { name: string } }) =>
      command.constructor.name === "GetCommand" ? { Item: tenant } : {},
    );
  }
  const hourlyQuestion = (extra: Record<string, unknown> = {}) =>
    eventWith({ question: "¿cuáles son las horas pico?", timeZone: "Europe/Madrid", ...extra }, "tenant-x");

  test("con zona del negocio: el prompt y el SQL usan la del negocio, no la del navegador (el bug de las 'horas colombianas' de Madrid)", async () => {
    mockTenant({ tenantId: "tenant-x", advisor: { timeZone: "America/Bogota" } });
    mockBedrockSend
      .mockResolvedValueOnce(toolUseResponse("tu1", "run_widget_query", { field: "event_count", aggregation: "count", groupBy: "hour" }))
      .mockResolvedValueOnce(textResponse("El pico es 17:00."));
    mockRunAthenaQuery.mockResolvedValue([{ label: "2026-10-01 17", value: 3 }]);

    const result = await handler(hourlyQuestion());

    expect(result.statusCode).toBe(200);
    const systemText = mockBedrockSend.mock.calls[0][0].input.system[0].text as string;
    expect(systemText).toContain("zona horaria del negocio: America/Bogota");
    expect(systemText).toContain("No conviertas horas a otra zona");
    expect(systemText).not.toContain("zona horaria del usuario");
    const sql = mockRunAthenaQuery.mock.calls[0][0] as string;
    expect(sql).toContain("America/Bogota");
    expect(sql).not.toContain("Europe/Madrid");
  });

  test("sin zona del negocio: la del navegador, como antes", async () => {
    mockTenant({ tenantId: "tenant-x" });
    mockBedrockSend
      .mockResolvedValueOnce(toolUseResponse("tu1", "run_widget_query", { field: "event_count", aggregation: "count", groupBy: "hour" }))
      .mockResolvedValueOnce(textResponse("ok"));
    mockRunAthenaQuery.mockResolvedValue([]);

    await handler(hourlyQuestion());

    const systemText = mockBedrockSend.mock.calls[0][0].input.system[0].text as string;
    expect(systemText).toContain("zona horaria del usuario: Europe/Madrid");
    expect(mockRunAthenaQuery.mock.calls[0][0]).toContain("Europe/Madrid");
  });

  test("la fecha de 'hoy' también es la del negocio", async () => {
    mockTenant({ tenantId: "tenant-x", advisor: { timeZone: "Pacific/Kiritimati" } }); // UTC+14: ya es otro día
    mockBedrockSend.mockResolvedValue(textResponse("ok"));

    await handler(hourlyQuestion({ timeZone: "Pacific/Pago_Pago" })); // UTC-11

    const systemText = mockBedrockSend.mock.calls[0][0].input.system[0].text as string;
    const kiritimati = new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Kiritimati" }).format(new Date());
    expect(systemText).toContain(`Hoy es ${kiritimati} (zona horaria del negocio: Pacific/Kiritimati)`);
  });
});

describe("medio de pago", () => {
  test("filters.paymentMethod (\"datafono\") llega al SQL como el valor exacto guardado", async () => {
    mockBedrockSend
      .mockResolvedValueOnce(toolUseResponse("tu1", "run_widget_query", { field: "total", aggregation: "sum", filters: { paymentMethod: "datafono" } }))
      .mockResolvedValueOnce(textResponse("No hay ventas con datafono."));
    mockRunAthenaQuery.mockResolvedValue([{ value: null }]);

    const result = await handler(eventWith({ question: "¿ventas con datafono?" }, "tenant-x"));

    expect(result.statusCode).toBe(200);
    const [sql, params] = mockRunAthenaQuery.mock.calls[0];
    expect(sql).toContain("paymentmethod = ?");
    expect(params).toContain("Datafono");
  });

  test("sin ventas con ese medio, el resultado dice explícito que es cero y que no hay que reconsultar sin el filtro", async () => {
    mockBedrockSend
      .mockResolvedValueOnce(toolUseResponse("tu1", "run_widget_query", { field: "total", aggregation: "sum", filters: { paymentMethod: "Datafono" } }))
      .mockResolvedValueOnce(textResponse("No hay ventas con datafono."));
    mockRunAthenaQuery.mockResolvedValue([{ value: null }]);

    await handler(eventWith({ question: "¿ventas con datafono?" }));

    const toolResult = mockBedrockSend.mock.calls[1][0].input.messages[2].content[0].toolResult;
    const payload = JSON.parse(toolResult.content[0].text ?? JSON.stringify(toolResult.content[0].json));
    expect(payload.filters).toEqual({ paymentMethod: "Datafono" });
    expect(payload.note).toMatch(/No hay ventas pagadas con Datafono/);
  });

  test("con ventas en ese medio no hay nota", async () => {
    mockBedrockSend
      .mockResolvedValueOnce(toolUseResponse("tu1", "run_widget_query", { field: "total", aggregation: "sum", filters: { paymentMethod: "QR" } }))
      .mockResolvedValueOnce(textResponse("QR: 1.962.300"));
    mockRunAthenaQuery.mockResolvedValue([{ value: 1962300 }]);

    await handler(eventWith({ question: "¿ventas en QR?" }));

    const toolResult = mockBedrockSend.mock.calls[1][0].input.messages[2].content[0].toolResult;
    const payload = JSON.parse(toolResult.content[0].text ?? JSON.stringify(toolResult.content[0].json));
    expect(payload.note).toBeUndefined();
  });

  test("el prompt prohíbe buscar un medio de pago como producto y limita la regla de reconsultar al filtro de producto", async () => {
    mockBedrockSend.mockResolvedValue(textResponse("ok"));
    await handler(eventWith({ question: "hola" }));
    const systemText = mockBedrockSend.mock.calls[0][0].input.system[0].text as string;
    expect(systemText).toContain('NUNCA busques un medio de pago con "descriptionContains"');
    expect(systemText).toContain('Esa regla es SOLO para el filtro de producto');
  });
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
  { paymentMethod: "bitcoin" }, { paymentMethod: 5 }, { paymentMethod: "Otro medio" },
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

const BRANCH_AGENTS = [
  { agentId: "agent-sol", name: "TPV Sol", location: { label: "Horno Castizo · Sol" } },
  { agentId: "agent-atocha", name: "TPV Atocha", location: { label: "Horno Castizo · Atocha" } },
  { agentId: "agent-solera", name: "TPV Solera" },
];
function mockBranchAgents() {
  mockDdbSend.mockImplementation(async (cmd: { input: { TableName?: string } }) =>
    cmd.input.TableName === "TestAgents" ? { Items: BRANCH_AGENTS } : {},
  );
}

test("run_widget_query con filters.branch: el nombre se traduce a agentId (parámetro SQL) y el modelo recibe el nombre", async () => {
  mockBedrockSend
    .mockResolvedValueOnce(
      toolUseResponse("tu1", "run_widget_query", {
        field: "quantity", aggregation: "sum", groupBy: "description", filters: { branch: "TPV Sol" },
      }),
    )
    .mockResolvedValueOnce(textResponse("Listo."));
  mockRunAthenaQuery.mockResolvedValue([{ label: "Menú del día", value: 2760 }]);
  mockBranchAgents();

  await handler(eventWith({ question: "¿qué se vende más en Sol?" }, "tenant-x"));

  const [sql, params] = mockRunAthenaQuery.mock.calls[0];
  expect(sql).toContain("agentid = ?");
  expect(sql).not.toContain("agent-sol");
  expect(params).toContain("agent-sol");
  const json = mockBedrockSend.mock.calls[1][0].input.messages[2].content[0].toolResult.content[0].json;
  expect(json.filters).toEqual({ branch: "Horno Castizo · Sol" });
  expect(JSON.stringify(json)).not.toContain("agent-sol");
});

test("run_widget_query con filters.branch: acepta una coincidencia parcial única, sin tildes ni mayúsculas", async () => {
  mockBedrockSend
    .mockResolvedValueOnce(toolUseResponse("tu1", "run_widget_query", { field: "total", aggregation: "sum", filters: { branch: "ATOCHA" } }))
    .mockResolvedValueOnce(textResponse("Listo."));
  mockRunAthenaQuery.mockResolvedValue([{ value: 10 }]);
  mockBranchAgents();

  await handler(eventWith({ question: "ventas de atocha" }, "tenant-x"));

  expect(mockRunAthenaQuery.mock.calls[0][1]).toContain("agent-atocha");
});

test.each([
  ["so", /coincide con varias sucursales: .*Horno Castizo · Sol.*TPV Solera/],
  ["Chueca", /no existe la sucursal .*Chueca.*Sucursales disponibles: .*Horno Castizo · Sol/],
])("run_widget_query con filters.branch \"%s\": si no es única no consulta y le devuelve las opciones al modelo", async (branch, message) => {
  mockBedrockSend
    .mockResolvedValueOnce(toolUseResponse("tu1", "run_widget_query", { field: "total", aggregation: "sum", filters: { branch } }))
    .mockResolvedValueOnce(textResponse("¿Cuál?"));
  mockBranchAgents();

  await handler(eventWith({ question: "ventas" }, "tenant-x"));

  expect(mockRunAthenaQuery).not.toHaveBeenCalled();
  const toolResult = mockBedrockSend.mock.calls[1][0].input.messages[2].content[0].toolResult;
  expect(toolResult.status).toBe("error");
  expect(JSON.stringify(toolResult.content)).toMatch(message);
});

test("el prompt y la herramienta ofrecen filters.branch para una sola sucursal", async () => {
  mockBedrockSend.mockResolvedValueOnce(textResponse("hola"));
  await handler(eventWith({ question: "hola" }));
  const input = mockBedrockSend.mock.calls[0][0].input;
  expect(input.system[0].text).toContain('filtro "branch"');
  const tool = input.toolConfig.tools.find((t: { toolSpec: { name: string } }) => t.toolSpec.name === "run_widget_query");
  expect(tool.toolSpec.inputSchema.json.properties.filters.properties.branch).toBeDefined();
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
  expect(system).toMatch(/Moneda:.*\(no definida\)|sin símbolo/);
});

test("create_widget: KPI de un producto en una sucursal devuelve el widget con agentId y descriptionContains", async () => {
  mockBedrockSend
    .mockResolvedValueOnce(
      toolUseResponse("tu1", "create_widget", {
        name: "Café con leche · Sol", visualization: "kpi", field: "subtotal", aggregation: "sum",
        filters: { branch: "TPV Sol", descriptionContains: "cafe con leche" },
      }),
    )
    .mockResolvedValueOnce(textResponse("Listo, añadí el KPI."));
  mockRunAthenaQuery.mockResolvedValue([{ value: 1234.5 }]);
  mockBranchAgents();

  const result = await handler(eventWith({ question: "kpi de café con leche en sol" }, "tenant-x"));

  expect(result.statusCode).toBe(200);
  expect(JSON.parse(result.body).widget).toEqual({
    name: "Café con leche · Sol",
    visualization: "kpi",
    metric: { field: "subtotal", aggregation: "sum" },
    filters: { agentId: "agent-sol", descriptionContains: "cafe con leche" },
  });
  const [sql, params] = mockRunAthenaQuery.mock.calls[0];
  expect(sql).toContain("agentid = ?");
  expect(params).toEqual(expect.arrayContaining(["agent-sol", "cafe con leche"]));
  const json = mockBedrockSend.mock.calls[1][0].input.messages[2].content[0].toolResult.content[0].json;
  expect(json).toMatchObject({ ok: true, branch: "Horno Castizo · Sol", descriptionContains: "cafe con leche", preview: [{ value: 1234.5 }] });
  expect(JSON.stringify(json)).not.toContain("agent-sol");
});

test.each([
  ["total con filtro de producto", { visualization: "kpi", field: "total", aggregation: "sum", filters: { descriptionContains: "cafe" } }, /un valor por ticket/],
  ["kpi con groupBy", { visualization: "kpi", field: "subtotal", aggregation: "sum", groupBy: "agent" }, /no admite groupBy/],
  ["barras sin groupBy", { visualization: "bar", field: "subtotal", aggregation: "sum" }, /necesita groupBy/],
  ["línea sin groupBy temporal", { visualization: "line", field: "subtotal", aggregation: "sum", groupBy: "agent" }, /groupBy temporal/],
  ["rango de fechas", { visualization: "kpi", field: "subtotal", aggregation: "sum", filters: { dateFrom: "2026-10-01" } }, /solo admiten los filtros/],
  ["sucursal inexistente", { visualization: "kpi", field: "subtotal", aggregation: "sum", filters: { branch: "Chueca" } }, /no existe la sucursal/],
])("create_widget rechaza %s: no devuelve widget y el modelo recibe el error", async (_caso, input, message) => {
  mockBedrockSend
    .mockResolvedValueOnce(toolUseResponse("tu1", "create_widget", { name: "X", ...input }))
    .mockResolvedValueOnce(textResponse("No pude."));
  mockBranchAgents();

  const result = await handler(eventWith({ question: "kpi" }, "tenant-x"));

  expect(JSON.parse(result.body).widget).toBeUndefined();
  const toolResult = mockBedrockSend.mock.calls[1][0].input.messages[2].content[0].toolResult;
  expect(toolResult.status).toBe("error");
  expect(JSON.stringify(toolResult.content)).toMatch(message);
});

test("create_widget: el prompt la describe y manda pasar las condiciones como filtros", async () => {
  mockBedrockSend.mockResolvedValueOnce(textResponse("hola"));
  await handler(eventWith({ question: "hola" }));
  const input = mockBedrockSend.mock.calls[0][0].input;
  expect(input.system[0].text).toContain('"create_widget"');
  expect(input.toolConfig.tools.map((t: { toolSpec: { name: string } }) => t.toolSpec.name)).toContain("create_widget");
});

describe("P0 especialista de negocio (Innova)", () => {
  function mockTenantAndAgents(tenant: Record<string, unknown>, agents: unknown[] = BRANCH_AGENTS) {
    mockDdbSend.mockImplementation(async (command: { constructor: { name: string }; input: { TableName?: string } }) => {
      if (command.constructor.name === "GetCommand" && command.input.TableName !== "TestMatters") {
        return { Item: tenant };
      }
      if (command.input.TableName === "TestAgents") return { Items: agents };
      return {};
    });
  }

  test("el prompt se presenta como Innova especialista y conserva reglas anti-alucinación", async () => {
    mockBedrockSend.mockResolvedValue(textResponse("ok"));
    await handler(eventWith({ question: "hola" }));
    const systemText = mockBedrockSend.mock.calls[0][0].input.system[0].text as string;
    expect(systemText).toContain("Sos Innova, el especialista del negocio");
    expect(systemText).not.toContain("Sos el asistente de datos");
    expect(systemText).toContain("nunca inventes números");
    expect(systemText).toContain("list_matters");
    expect(systemText).toContain("explain_matter");
    expect(systemText).toContain('agrupá por "hourOfDay"');
  });

  test("inyecta businessName, zona y sucursales en el system prompt", async () => {
    mockTenantAndAgents(
      { tenantId: "tenant-x", businessName: "Empanadas El Sol", advisor: { timeZone: "America/Bogota" } },
      [
        { agentId: "a1", name: "Robot Centro", location: { label: "Centro" } },
        { agentId: "a2", name: "Robot Chapinero", location: { label: "Chapinero" } },
      ],
    );
    mockBedrockSend.mockResolvedValue(textResponse("ok"));

    await handler(eventWith({ question: "hola", timeZone: "Europe/Madrid" }, "tenant-x"));

    const systemText = mockBedrockSend.mock.calls[0][0].input.system[0].text as string;
    expect(systemText).toContain("Nombre: Empanadas El Sol");
    expect(systemText).toContain("Sucursales (robots): Centro, Chapinero");
    expect(systemText).toContain("Moneda: (no definida)");
    expect(systemText).toContain("Horarios: (no cargados");
    expect(systemText).toContain("zona horaria del negocio: America/Bogota");
  });

  test("inyecta currency, horarios e industry de tenant.profile", async () => {
    mockTenantAndAgents({
      tenantId: "tenant-x",
      businessName: "Empanadas El Sol",
      advisor: { timeZone: "America/Bogota" },
      profile: {
        currency: "COP",
        locale: "es-CO",
        industry: "restaurante",
        openingHours: { default: { open: "08:00", close: "20:00" }, byWeekday: { "7": "closed" } },
      },
    });
    mockBedrockSend.mockResolvedValue(textResponse("ok"));
    await handler(eventWith({ question: "hola" }, "tenant-x"));
    const systemText = mockBedrockSend.mock.calls[0][0].input.system[0].text as string;
    expect(systemText).toContain("Moneda / locale: COP (es-CO)");
    expect(systemText).toContain("default 08:00–20:00");
    expect(systemText).toContain("dom cerrado");
    expect(systemText).toContain("Rubro: restaurante");
    expect(systemText).toContain("list_widgets");
  });

  test("registra tools list_matters, explain_matter y list_widgets", async () => {
    mockBedrockSend.mockResolvedValue(textResponse("ok"));
    await handler(eventWith({ question: "hola" }));
    const names = mockBedrockSend.mock.calls[0][0].input.toolConfig.tools.map(
      (t: { toolSpec: { name: string } }) => t.toolSpec.name,
    );
    expect(names).toEqual(
      expect.arrayContaining(["list_matters", "explain_matter", "list_widgets", "run_widget_query", "list_tickets", "create_widget"]),
    );
  });

  test("list_widgets: el modelo recibe el catálogo del dashboard", async () => {
    mockDdbSend.mockImplementation(async (command: { constructor: { name: string }; input: { TableName?: string } }) => {
      if (command.input.TableName === "TestWidgets") {
        return {
          Items: [
            {
              widgetId: "w1",
              name: "Ventas totales",
              visualization: "kpi",
              metric: { field: "total", aggregation: "sum" },
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        };
      }
      return {};
    });
    mockBedrockSend
      .mockResolvedValueOnce(toolUseResponse("tu1", "list_widgets", { limit: 10 }))
      .mockResolvedValueOnce(textResponse("Ya tenés Ventas totales"));

    const result = await handler(eventWith({ question: "creame un kpi de ventas" }));
    expect(result.statusCode).toBe(200);
    const toolResult = mockBedrockSend.mock.calls[1][0].input.messages[2].content[0].toolResult;
    expect(toolResult.status).toBeUndefined();
    expect(toolResult.content[0].json.widgets[0].title).toBe("Ventas totales");
  });

  test("matterId inválido → 400", async () => {
    const result = await handler(eventWith({ question: "explicame", matterId: "no es base64!" }));
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain("matterId");
    expect(mockBedrockSend).not.toHaveBeenCalled();
  });

  test("matterId válido prefija el mensaje al modelo para forzar explain_matter", async () => {
    const matterId = Buffer.from("2026-11-09#agent_offline#branch:a1", "utf-8").toString("base64url");
    mockBedrockSend.mockResolvedValue(textResponse("ok"));

    const result = await handler(
      eventWith({ question: "Explícame este aviso: TPV Sol offline", matterId }, "tenant-x"),
    );

    expect(result.statusCode).toBe(200);
    // El array messages se muta después: miramos lo que se envió en la 1ª llamada a Bedrock.
    const userText = mockBedrockSend.mock.calls[0][0].input.messages[0].content[0].text as string;
    expect(userText).toContain(`matterId="${matterId}"`);
    expect(userText).toContain("explain_matter");
    expect(userText).toContain("Explícame este aviso: TPV Sol offline");
  });

  test("list_matters: el modelo recibe avisos públicos sin claves internas", async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockBedrockSend
      .mockResolvedValueOnce(toolUseResponse("tu1", "list_matters", { limit: 5 }))
      .mockResolvedValueOnce(textResponse("Hay 1 aviso abierto."));
    mockDdbSend.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "GetCommand") return { Item: { tenantId: "tenant-x", businessName: "Demo" } };
      if (command.input.TableName === "TestMatters") {
        return {
          Items: [
            {
              pk: "TENANT#tenant-x",
              sk: `MATTER#${today}#agent_offline#branch:a1`,
              tenantId: "tenant-x",
              detector: "agent_offline",
              scope: "branch:a1",
              periodDate: today,
              severity: "warn",
              status: "new",
              evidence: { agentName: "Caja 1", minutesSinceSeen: 45 },
              createdAt: "2026-11-09T12:00:00Z",
              updatedAt: "2026-11-09T12:00:00Z",
              ttl: 1,
            },
          ],
        };
      }
      if (command.input.TableName === "TestAgents") {
        return { Items: [{ agentId: "a1", name: "Caja 1", location: { label: "Sede Norte" } }] };
      }
      return {};
    });

    const result = await handler(eventWith({ question: "¿qué avisos hay?" }, "tenant-x"));

    expect(result.statusCode).toBe(200);
    const payload = mockBedrockSend.mock.calls[1][0].input.messages[2].content[0].toolResult.content[0].json;
    expect(payload.matters).toHaveLength(1);
    expect(payload.matters[0]).toMatchObject({
      detector: "agent_offline",
      severity: "warn",
      status: "new",
      branchLabel: "Sede Norte",
      title: expect.stringContaining("Sede Norte"),
    });
    expect(payload.matters[0]).not.toHaveProperty("pk");
    expect(payload.matters[0]).not.toHaveProperty("ttl");
  });

  test("explain_matter: devuelve evidence y chequeos sin inventar causas", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const matterId = Buffer.from(`${today}#capture_zero#branch:a1`, "utf-8").toString("base64url");
    mockBedrockSend
      .mockResolvedValueOnce(toolUseResponse("tu1", "explain_matter", { matterId }))
      .mockResolvedValueOnce(textResponse("Revisá la impresora."));
    mockDdbSend.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.input.TableName === "TestMatters" && command.constructor.name === "GetCommand") {
        return {
          Item: {
            pk: "TENANT#tenant-x",
            sk: `MATTER#${today}#capture_zero#branch:a1`,
            tenantId: "tenant-x",
            detector: "capture_zero",
            scope: "branch:a1",
            periodDate: today,
            severity: "critical",
            status: "new",
            expected: 12,
            actual: 0,
            evidence: { windowHours: 3, agentName: "Caja 1" },
            createdAt: "2026-11-09T12:00:00Z",
            updatedAt: "2026-11-09T12:00:00Z",
            ttl: 1,
          },
        };
      }
      if (command.constructor.name === "GetCommand") return { Item: { tenantId: "tenant-x", businessName: "Demo" } };
      if (command.input.TableName === "TestAgents") {
        return { Items: [{ agentId: "a1", name: "Caja 1", location: { label: "Sede Norte" } }] };
      }
      return {};
    });

    const result = await handler(eventWith({ question: "explicame el aviso", matterId }, "tenant-x"));

    expect(result.statusCode).toBe(200);
    const payload = mockBedrockSend.mock.calls[1][0].input.messages[2].content[0].toolResult.content[0].json;
    expect(payload).toMatchObject({
      detector: "capture_zero",
      expected: 12,
      actual: 0,
      evidence: { windowHours: 3, agentName: "Caja 1" },
    });
    expect(payload.checks.length).toBeGreaterThan(0);
    expect(payload.note).toMatch(/No inventes/);
  });
});
