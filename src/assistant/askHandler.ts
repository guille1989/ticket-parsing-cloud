import { BedrockRuntimeClient, ConverseCommand, type ContentBlock, type Message, type Tool } from "@aws-sdk/client-bedrock-runtime";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { checkAssistantRateLimit } from "./rateLimit.js";
import { resolveTenantIdFromEvent } from "../shared/auth.js";
import { ddb, TICKETS_TABLE } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import type { TicketRecord, TicketStatus, WidgetAggregation, WidgetFilters, WidgetRecord } from "../shared/types.js";
import { runWidgetQuery as runAthenaQuery } from "../widgets/athenaQuery.js";
import {
  AGGREGATIONS,
  CATEGORICAL_FIELDS,
  EVENT_COUNT_FIELD,
  NUMERIC_FIELDS,
  isTicketLevelField,
  isValidAggregation,
  isValidGroupByField,
  isValidMetricField,
} from "../widgets/fields.js";
import { buildWidgetQuery } from "../widgets/queryBuilder.js";

const bedrock = new BedrockRuntimeClient({});

const MAX_QUESTION_LENGTH = 500;
// Cada turno es una llamada a Bedrock; con tool-use, una pregunta típica
// necesita 2 (pedir la herramienta -> responder con el resultado). El tope
// evita que una pregunta rara entre en un ciclo largo y caro.
const MAX_TURNS = 4;

const TICKET_STATUSES: TicketStatus[] = ["pending", "parsed", "needs_review", "failed"];
const LIST_TICKETS_DEFAULT_LIMIT = 10;
const LIST_TICKETS_MAX_LIMIT = 15;

const SYSTEM_PROMPT = `Sos el asistente de datos del dashboard de un negocio que usa InnoApp para capturar y analizar tickets de venta. Contestá siempre en español, en pocas oraciones, directo al grano.

Tenés dos herramientas para consultar los datos REALES del negocio — nunca inventes números:
- "run_widget_query": totales/promedios/conteos, opcionalmente agrupados por robot/estado/producto. Usala para preguntas de agregados ("¿cuánto vendí?", "¿qué producto vendió más?", "comparame las sucursales").
- "list_tickets": los tickets más recientes, opcionalmente filtrados por estado. Usala para preguntas puntuales sobre ventas concretas, no para totales.

Si la pregunta no tiene que ver con los datos del negocio (tickets, ventas, robots), respondé brevemente que solo podés ayudar con eso. Basá la respuesta únicamente en lo que devolvió la herramienta — si no hay datos, decilo en vez de inventar. Cuando uses datos reales, mencioná brevemente sobre qué te basaste (ej. cantidad de tickets).

Puede haber preguntas anteriores de la misma conversación antes de la actual — usalas para interpretar referencias ambiguas ("¿y por producto?", "¿y la semana pasada?"), pero siempre volvé a llamar a la herramienta correspondiente para traer datos frescos, nunca reuses un número que hayas dado antes sin volver a consultarlo.`;

function buildTools(): Tool[] {
  return [
    {
      toolSpec: {
        name: "run_widget_query",
        description:
          "Calcula un agregado (suma, promedio, máximo, mínimo o cantidad) sobre los tickets de venta ya parseados del negocio, opcionalmente agrupado por una categoría y filtrado por fecha/puerto/estado.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              field: {
                type: "string",
                enum: [...NUMERIC_FIELDS, EVENT_COUNT_FIELD],
                description: "Campo a agregar. 'event_count' cuenta tickets en vez de sumar un campo.",
              },
              aggregation: { type: "string", enum: [...AGGREGATIONS], description: "Cómo agregar el campo." },
              groupBy: {
                type: "string",
                enum: [...CATEGORICAL_FIELDS],
                description: "Campo categórico para desglosar el resultado (opcional, omitir para un solo total).",
              },
              filters: {
                type: "object",
                properties: {
                  dateFrom: { type: "string", description: "Fecha ISO-8601 desde (opcional)." },
                  dateTo: { type: "string", description: "Fecha ISO-8601 hasta (opcional)." },
                  port: { type: "string", description: "Filtrar por un robot/puerto puntual (opcional)." },
                  status: { type: "string", enum: TICKET_STATUSES, description: "Filtrar por estado del ticket (opcional)." },
                },
              },
            },
            required: ["field", "aggregation"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "list_tickets",
        description: `Lista hasta ${LIST_TICKETS_MAX_LIMIT} tickets recientes del negocio, opcionalmente filtrados por estado. Para preguntas puntuales, no para totales.`,
        inputSchema: {
          json: {
            type: "object",
            properties: {
              status: { type: "string", enum: TICKET_STATUSES },
              limit: {
                type: "number",
                description: `Máximo de tickets a devolver (por defecto ${LIST_TICKETS_DEFAULT_LIMIT}, tope ${LIST_TICKETS_MAX_LIMIT}).`,
              },
            },
          },
        },
      },
    },
  ];
}

/**
 * Igual validación que `widgets/createHandler.ts` contra la lista blanca de
 * `widgets/fields.ts` — el input de esta herramienta lo arma el modelo, no
 * un usuario, pero el mismo principio aplica: nunca confiar un nombre de
 * campo directo, siempre revalidar antes de generar SQL.
 */
async function runWidgetQueryTool(input: unknown, tenantId: string): Promise<unknown> {
  const raw = (input ?? {}) as Record<string, unknown>;

  const field = typeof raw.field === "string" ? raw.field : "";
  if (!isValidMetricField(field)) {
    throw new Error(`campo inválido: "${field}". Válidos: ${[...NUMERIC_FIELDS, EVENT_COUNT_FIELD].join(", ")}`);
  }

  const aggregation = typeof raw.aggregation === "string" ? raw.aggregation : "";
  if (!isValidAggregation(aggregation)) {
    throw new Error(`agregación inválida: "${aggregation}". Válidas: ${AGGREGATIONS.join(", ")}`);
  }

  let groupBy: string | undefined;
  if (raw.groupBy !== undefined) {
    if (typeof raw.groupBy !== "string" || !isValidGroupByField(raw.groupBy)) {
      throw new Error(`groupBy inválido: "${String(raw.groupBy)}". Válidos: ${CATEGORICAL_FIELDS.join(", ")}`);
    }
    groupBy = raw.groupBy;
  }
  if (groupBy === "description" && isTicketLevelField(field)) {
    throw new Error(`no se puede agrupar "${field}" (un valor por ticket) por "description" (un valor por ítem) — usá "subtotal"`);
  }

  let filters: WidgetFilters | undefined;
  if (raw.filters && typeof raw.filters === "object") {
    const f = raw.filters as Record<string, unknown>;
    filters = {};
    if (typeof f.dateFrom === "string") filters.dateFrom = f.dateFrom;
    if (typeof f.dateTo === "string") filters.dateTo = f.dateTo;
    if (typeof f.port === "string") filters.port = f.port;
    if (typeof f.status === "string" && TICKET_STATUSES.includes(f.status as TicketStatus)) filters.status = f.status;
  }

  const widget: WidgetRecord = {
    tenantId,
    widgetId: "assistant-query",
    name: "assistant query",
    visualization: groupBy ? "bar" : "kpi",
    createdAt: new Date().toISOString(),
    metric: { field, aggregation: aggregation as WidgetAggregation },
    groupBy,
    filters,
  };

  const query = buildWidgetQuery(widget);
  const data = await runAthenaQuery(query.sql, query.params, process.env.ATHENA_WORKGROUP!);
  return { data };
}

/** Mismo query que `read/handler.ts`, recortado a lo que le sirve al modelo (sin items, para no inflar tokens). */
async function listTicketsTool(input: unknown, tenantId: string): Promise<unknown> {
  const raw = (input ?? {}) as Record<string, unknown>;

  const status = typeof raw.status === "string" && TICKET_STATUSES.includes(raw.status as TicketStatus) ? (raw.status as TicketStatus) : undefined;
  const limit =
    typeof raw.limit === "number" && Number.isInteger(raw.limit) && raw.limit > 0
      ? Math.min(raw.limit, LIST_TICKETS_MAX_LIMIT)
      : LIST_TICKETS_DEFAULT_LIMIT;

  const result = status
    ? await ddb.send(
        new QueryCommand({
          TableName: TICKETS_TABLE,
          IndexName: "status-index",
          KeyConditionExpression: "gsi1pk = :gsi1pk",
          ExpressionAttributeValues: { ":gsi1pk": `TENANT#${tenantId}#STATUS#${status}` },
          ScanIndexForward: false,
          Limit: limit,
        }),
      )
    : await ddb.send(
        new QueryCommand({
          TableName: TICKETS_TABLE,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": `TENANT#${tenantId}` },
          ScanIndexForward: false,
          Limit: limit,
        }),
      );

  const tickets = ((result.Items as TicketRecord[] | undefined) ?? []).map((t) => ({
    ticketId: t.ticketId,
    capturedAt: t.capturedAt,
    status: t.status,
    port: t.port,
    total: t.total,
  }));

  return { tickets, count: tickets.length };
}

async function callTool(name: string, input: unknown, tenantId: string): Promise<unknown> {
  if (name === "run_widget_query") return runWidgetQueryTool(input, tenantId);
  if (name === "list_tickets") return listTicketsTool(input, tenantId);
  throw new Error(`herramienta desconocida: "${name}"`);
}

type HistoryTurn = { role: "user" | "assistant"; text: string };
type Validation = { ok: true; question: string; history: HistoryTurn[] } | { ok: false; error: string };

// Memoria de conversación acotada: el cliente manda los últimos intercambios
// (los mismos que ya muestra en pantalla), el servidor los antepone al
// mensaje nuevo. A propósito NO viajan resultados de herramientas de turnos
// anteriores — cada pregunta nueva vuelve a consultar datos frescos en vez
// de confiar en un número que pudo haber cambiado desde entonces.
const MAX_HISTORY_TURNS = 6;

function validateHistory(raw: unknown): { ok: true; history: HistoryTurn[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, history: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "history inválida, se esperaba un array" };
  if (raw.length > MAX_HISTORY_TURNS) {
    return { ok: false, error: `history demasiado larga (máx ${MAX_HISTORY_TURNS} mensajes)` };
  }

  const history: HistoryTurn[] = [];
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: `history[${i}] inválido` };
    }
    const { role, text } = item as Record<string, unknown>;
    // Bedrock exige que los mensajes alternen empezando por "user" — se
    // valida acá para no dejar que un history mal armado le llegue a la API.
    const expectedRole = i % 2 === 0 ? "user" : "assistant";
    if (role !== expectedRole) {
      return { ok: false, error: `history[${i}].role inválido, se esperaba "${expectedRole}" (debe alternar empezando por "user")` };
    }
    if (typeof text !== "string" || text.trim().length === 0 || text.length > MAX_QUESTION_LENGTH) {
      return { ok: false, error: `history[${i}].text inválido` };
    }
    history.push({ role: role as "user" | "assistant", text: text.trim() });
  }
  return { ok: true, history };
}

function validateBody(body: unknown): Validation {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "se esperaba un objeto JSON" };
  }
  const b = body as Record<string, unknown>;

  const question = b.question;
  if (typeof question !== "string" || question.trim().length === 0) {
    return { ok: false, error: "question inválida (string no vacío)" };
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return { ok: false, error: `question demasiado larga (máx ${MAX_QUESTION_LENGTH} caracteres)` };
  }

  const historyValidation = validateHistory(b.history);
  if (!historyValidation.ok) {
    return { ok: false, error: historyValidation.error };
  }

  return { ok: true, question: question.trim(), history: historyValidation.history };
}

/**
 * Único registro de auditoría de una pregunta respondida — hasta ahora solo
 * logueábamos errores, nunca una respuesta normal (sección 13 de
 * PROYECTO.md). Una línea JSON por pregunta: sirve para revisar calidad de
 * respuestas, ver qué preguntan de verdad los negocios, y detectar un uso
 * anómalo de un tenant antes de que aparezca en la factura de Bedrock/Athena
 * (complementa al rate limit, que solo frena el caso extremo). Va a
 * CloudWatch Logs sin infraestructura nueva — retención acotada a propósito
 * en el stack (ver `AssistantAskFunction` en el CDK), porque esto guarda
 * contenido real de negocio (montos, productos), no solo metadata técnica.
 */
function logQa(entry: { tenantId: string; question: string; answer: string; toolsUsed: string[]; turns: number; historyTurns: number }): void {
  console.log(JSON.stringify({ event: "assistant_qa", timestamp: new Date().toISOString(), ...entry }));
}

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = resolveTenantIdFromEvent(event);
  if (!tenantId) {
    return jsonResponse(403, { error: "no autenticado" });
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

  // Chequeo barato (una escritura condicional a DynamoDB) antes de gastar
  // en Bedrock/Athena — ver rateLimit.ts para el motivo (este endpoint no
  // tiene api-key, así que el usage plan de API Gateway no lo protege).
  const rateLimit = await checkAssistantRateLimit(tenantId);
  if (!rateLimit.ok) {
    const message =
      rateLimit.reason === "minute"
        ? "Estás preguntando muy rápido, esperá un momento antes de volver a intentar."
        : "Llegaste al límite de preguntas de hoy para el asistente, probá de nuevo mañana.";
    return jsonResponse(429, { error: message });
  }

  const modelId = process.env.BEDROCK_MODEL_ID!;
  const tools = buildTools();
  const messages: Message[] = [
    ...validation.history.map((turn): Message => ({ role: turn.role, content: [{ text: turn.text }] })),
    { role: "user", content: [{ text: validation.question }] },
  ];
  // Para el log de auditoría al final — qué herramientas se invocaron, sin
  // importar si tuvieron éxito (un intento de herramienta inexistente
  // también es una señal útil, ver logQa()).
  const toolsUsed: string[] = [];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await bedrock.send(
        new ConverseCommand({
          modelId,
          system: [{ text: SYSTEM_PROMPT }],
          messages,
          toolConfig: { tools },
          // Acotado a propósito (costo/latencia) — sección 10.1 de PROYECTO.md
          // ya mostró lo rápido que un costo "chico" escala sin límites explícitos.
          inferenceConfig: { maxTokens: 512, temperature: 0.3 },
        }),
      );

      const outputMessage = response.output?.message;
      if (!outputMessage) {
        return jsonResponse(502, { error: "el modelo no devolvió respuesta" });
      }
      messages.push(outputMessage);

      if (response.stopReason !== "tool_use") {
        const text = outputMessage.content?.find((block) => typeof block.text === "string")?.text;
        if (!text) {
          return jsonResponse(502, { error: "el modelo no devolvió respuesta" });
        }
        logQa({ tenantId, question: validation.question, answer: text, toolsUsed, turns: turn + 1, historyTurns: validation.history.length });
        return jsonResponse(200, { answer: text });
      }

      const toolUseBlocks = (outputMessage.content ?? []).filter((block) => block.toolUse);
      const toolResultContent: ContentBlock[] = await Promise.all(
        toolUseBlocks.map(async (block): Promise<ContentBlock> => {
          const toolUse = block.toolUse!;
          toolsUsed.push(toolUse.name ?? "(sin nombre)");
          try {
            const result = await callTool(toolUse.name ?? "", toolUse.input, tenantId);
            return {
              toolResult: { toolUseId: toolUse.toolUseId, content: [{ json: result as Record<string, unknown> }] },
            } as ContentBlock;
          } catch (err) {
            console.error(`[assistant] fallo la herramienta "${toolUse.name}":`, err);
            return {
              toolResult: {
                toolUseId: toolUse.toolUseId,
                content: [{ text: err instanceof Error ? err.message : "error desconocido" }],
                status: "error" as const,
              },
            } as ContentBlock;
          }
        }),
      );

      messages.push({ role: "user", content: toolResultContent });
    }

    return jsonResponse(502, { error: "el asistente no pudo resolver la pregunta, probá reformularla" });
  } catch (err) {
    console.error("[assistant] fallo al invocar Bedrock:", err);
    return jsonResponse(502, { error: "no se pudo generar una respuesta, probá de nuevo en unos segundos" });
  }
}
