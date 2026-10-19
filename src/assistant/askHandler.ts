import { BedrockRuntimeClient, ConverseCommand, type ContentBlock, type Message, type Tool } from "@aws-sdk/client-bedrock-runtime";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { checkAssistantRateLimit } from "./rateLimit.js";
import { saveReport } from "./reportStore.js";
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
  TEMPORAL_FIELDS,
  isTicketLevelField,
  isValidAggregation,
  isValidGroupByField,
  isValidTimeZone,
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
// Menos que el tope de los widgets (MAX_GROUPS en queryBuilder.ts): cada
// fila le llega al modelo como tokens de entrada, y para contestar "¿qué
// producto vendió más?" alcanza con los primeros 50 ordenados por valor.
const ASSISTANT_MAX_GROUPS = 50;
const LIST_TICKETS_DEFAULT_LIMIT = 10;
const LIST_TICKETS_MAX_LIMIT = 15;
const MAX_DESCRIPTION_FILTER_LENGTH = 50;
const REPORT_MAX_SECTIONS = 6;
const REPORT_MAX_TITLE_LENGTH = 100;

const SYSTEM_PROMPT = `Sos el asistente de datos del dashboard de un negocio que usa InnoApp para capturar y analizar tickets de venta. Contestá siempre en español, en pocas oraciones, directo al grano.

Tenés tres herramientas para consultar los datos REALES del negocio — nunca inventes números:
- "run_widget_query": totales/promedios/conteos, opcionalmente agrupados por robot/estado/producto o por día. Usala para preguntas de agregados ("¿cuánto vendí?", "¿qué producto vendió más?", "comparame las sucursales", "¿qué día vendí más?").
- "list_tickets": los tickets más recientes, opcionalmente filtrados por estado. Usala para preguntas puntuales sobre ventas concretas, no para totales.

- "build_report": arma un reporte descargable (varias secciones, cada una con su consulta). Usala SOLO cuando el usuario pida un reporte, informe o resumen para descargar. Las tablas las calcula la herramienta con datos reales; vos no transcribas números. Después de llamarla, contestá en pocas oraciones con los hallazgos principales y decí que el reporte está listo para descargar.

No pidas aclaraciones si la pregunta se puede contestar con una suposición razonable: consultá, contestá y decí en una frase qué supusiste. Supuestos por defecto:
- "Ventas" es plata: "subtotal" si es por producto, "total" si es del negocio entero.
- Para "lo más vendido" o "el producto que más se vende" usá "quantity" (unidades vendidas) con sum, agrupado por producto. "event_count" cuenta tickets que incluyen el producto (un ticket con 3 horneadas cuenta 1): usalo solo si piden transacciones, tickets o clientes. Nunca mezcles las dos métricas en una misma comparación y decí siempre cuál usaste ("unidades" o "tickets"). En los títulos de las secciones de un reporte nombrá la métrica ("Unidades vendidas por producto", "Tickets por producto").
- Un mes o un día sin año es el más reciente que ya empezó, según la fecha de hoy (va al final).
- "Las horneadas", "lo que diga empanadas" y parecidos son un tipo de producto: usá el filtro "descriptionContains" con una raíz corta de la palabra, una consulta por cada tipo. La suma la hace la herramienta, no la calcules vos.
Pedí aclaración solo si no hay ninguna interpretación razonable.

Si la pregunta no tiene que ver con los datos del negocio (tickets, ventas, robots), respondé brevemente que solo podés ayudar con eso. Basá la respuesta únicamente en lo que devolvió la herramienta — si no hay datos, decilo en vez de inventar. Cuando uses datos reales, mencioná brevemente sobre qué te basaste (ej. cantidad de tickets).

Puede haber preguntas anteriores de la misma conversación antes de la actual — usalas para interpretar referencias ambiguas ("¿y por producto?", "¿y la semana pasada?"), pero siempre volvé a llamar a la herramienta correspondiente para traer datos frescos, nunca reuses un número que hayas dado antes sin volver a consultarlo.

Si una herramienta devuelve un error, no adivines por qué falló ni le atribuyas la causa a los datos del negocio (por ejemplo al estado de los tickets). Si el error dice que un parámetro es inválido, corregilo y probá de nuevo. Si es otro tipo de error, decile al usuario que hubo un problema técnico al consultar los datos y que pruebe de nuevo en un rato, y ofrecé lo que sí hayas podido consultar.`;

/**
 * El modelo no sabe qué día es: sin esto, "ventas de octubre" terminaba en
 * "¿octubre de qué año?" (2026-10-16). UTC, igual que el agrupado por "day".
 */
function buildSystemPrompt(now: Date, timeZone?: string): string {
  if (timeZone) {
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    return `${SYSTEM_PROMPT}\n\nHoy es ${localDate} (zona horaria del usuario: ${timeZone}). Las fechas y horas de las consultas están en esa zona.`;
  }
  return `${SYSTEM_PROMPT}\n\nHoy es ${now.toISOString().slice(0, 10)} (fecha UTC).`;
}

function widgetQueryProperties() {
  return {
      field: {
        type: "string",
        enum: [...NUMERIC_FIELDS, EVENT_COUNT_FIELD],
        description: "Campo a agregar. 'event_count' cuenta tickets en vez de sumar un campo.",
      },
      aggregation: { type: "string", enum: [...AGGREGATIONS], description: "Cómo agregar el campo." },
      groupBy: {
        type: "string",
        // Sin "day" acá el modelo no tenía forma de contestar "¿qué
        // día vendí más?" — runWidgetQueryTool ya lo aceptaba
        // (isValidGroupByField), solo faltaba ofrecerlo.
        enum: [...CATEGORICAL_FIELDS, ...TEMPORAL_FIELDS],
        description:
          "Campo para desglosar el resultado (opcional, omitir para un solo total). 'day' agrupa por fecha (YYYY-MM-DD) y 'hour' por hora (YYYY-MM-DD HH, 24h), ordenados de lo más viejo a lo más nuevo.",
      },
      filters: {
        type: "object",
        properties: {
          dateFrom: { type: "string", description: "Fecha desde, YYYY-MM-DD (opcional)." },
          dateTo: { type: "string", description: "Fecha hasta, YYYY-MM-DD, incluye ese día entero (opcional)." },
          port: { type: "string", description: "Filtrar por un robot/puerto puntual (opcional)." },
          status: { type: "string", enum: TICKET_STATUSES, description: "Filtrar por estado del ticket (opcional)." },
          descriptionContains: {
            type: "string",
            description:
              "Solo productos cuyo nombre contiene este texto, sin distinguir mayúsculas (opcional). Usá una raíz corta ('horne', 'empa') porque los nombres pueden venir abreviados. Solo con 'subtotal', 'quantity', 'unitPrice' o 'event_count'.",
          },
        },
      },
  };
}

function buildTools(): Tool[] {
  const queryProperties = widgetQueryProperties();
  return [
    {
      toolSpec: {
        name: "run_widget_query",
        description:
          "Calcula un agregado (suma, promedio, máximo, mínimo o cantidad) sobre los tickets de venta ya parseados del negocio, opcionalmente agrupado por una categoría o por día y filtrado por fecha/puerto/estado.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              ...queryProperties,
            },
            required: ["field", "aggregation"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "build_report",
        description: `Arma un reporte descargable con hasta ${REPORT_MAX_SECTIONS} secciones; cada sección es una consulta de datos con su título. Solo cuando el usuario pida un reporte/informe. Cada KPI con dateFrom y dateTo se compara solo con el periodo anterior (campo previous). Armá el reporte con 1 o 2 KPIs (sin groupBy), una tendencia (groupBy day) y un ranking (por description, port, etc.). Devuelve los datos para que redactes los hallazgos.`,
        inputSchema: {
          json: {
            type: "object",
            properties: {
              title: { type: "string", description: "Título del reporte (incluí el periodo si aplica)." },
              sections: {
                type: "array",
                maxItems: REPORT_MAX_SECTIONS,
                items: {
                  type: "object",
                  properties: {
                    heading: { type: "string", description: "Título de la sección, ej. 'Ventas por día'." },
                    ...queryProperties,
                  },
                  required: ["heading", "field", "aggregation"],
                },
              },
            },
            required: ["title", "sections"],
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
async function runWidgetQueryTool(input: unknown, tenantId: string, timeZone?: string): Promise<unknown> {
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
      throw new Error(`groupBy inválido: "${String(raw.groupBy)}". Válidos: ${[...CATEGORICAL_FIELDS, ...TEMPORAL_FIELDS].join(", ")}`);
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
    if (typeof f.descriptionContains === "string" && f.descriptionContains.trim()) {
      filters.descriptionContains = f.descriptionContains.trim().slice(0, MAX_DESCRIPTION_FILTER_LENGTH);
    }
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

  const query = buildWidgetQuery(widget, ASSISTANT_MAX_GROUPS, timeZone);
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

/**
 * `kpi` = un solo número, `trend` = serie por día, `ranking` = por categoría.
 * Se deduce de la consulta (no lo elige el modelo) para que el cliente sepa
 * qué gráfica dibujar sin depender de que el modelo lo etiquete bien.
 */
export type ReportSectionKind = "kpi" | "trend" | "ranking";
export type ReportSection = {
  kind: ReportSectionKind;
  heading: string;
  field: string;
  aggregation: string;
  groupBy?: string;
  filters?: Record<string, unknown>;
  data: Array<{ label?: string; value: number }>;
  /** Solo en `kpi` con dateFrom y dateTo: el mismo cálculo en el periodo anterior de igual duración. */
  previous?: number;
};
export type Report = { title: string; generatedAt: string; sections: ReportSection[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Periodo inmediatamente anterior y de igual duración; null si el rango no es de fechas válidas. */
function previousPeriod(dateFrom: unknown, dateTo: unknown): { dateFrom: string; dateTo: string } | null {
  if (typeof dateFrom !== "string" || typeof dateTo !== "string" || !ISO_DATE.test(dateFrom) || !ISO_DATE.test(dateTo)) return null;
  const from = Date.parse(`${dateFrom}T00:00:00Z`);
  const to = Date.parse(`${dateTo}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  const days = Math.round((to - from) / DAY_MS) + 1;
  const prevTo = from - DAY_MS;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { dateFrom: iso(prevTo - (days - 1) * DAY_MS), dateTo: iso(prevTo) };
}

/**
 * Las tablas del reporte salen de las mismas consultas validadas que usa
 * `run_widget_query`; el modelo solo elige título, secciones y filtros, nunca
 * escribe cifras. El reporte completo va al cliente en `report`; al modelo
 * solo le vuelven los datos para que redacte el resumen.
 */
async function buildReportTool(input: unknown, tenantId: string, ctx: ToolContext): Promise<unknown> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, REPORT_MAX_TITLE_LENGTH) : "";
  if (!title) throw new Error("title inválido (string no vacío)");
  if (!Array.isArray(raw.sections) || raw.sections.length === 0 || raw.sections.length > REPORT_MAX_SECTIONS) {
    throw new Error(`sections inválido: se esperaban entre 1 y ${REPORT_MAX_SECTIONS} secciones`);
  }

  const sections = await Promise.all(
    raw.sections.map(async (item, i): Promise<ReportSection> => {
      const section = (item ?? {}) as Record<string, unknown>;
      const heading = typeof section.heading === "string" ? section.heading.trim().slice(0, REPORT_MAX_TITLE_LENGTH) : "";
      if (!heading) throw new Error(`sections[${i}].heading inválido`);
      try {
        const { data } = (await runWidgetQueryTool(section, tenantId, ctx.timeZone)) as { data: ReportSection["data"] };
        const groupBy = typeof section.groupBy === "string" ? section.groupBy : undefined;
        const filters = section.filters && typeof section.filters === "object" ? (section.filters as Record<string, unknown>) : undefined;
        const kind: ReportSectionKind = !groupBy ? "kpi" : groupBy === "day" || groupBy === "hour" ? "trend" : "ranking";

        let previous: number | undefined;
        const prevRange = kind === "kpi" ? previousPeriod(filters?.dateFrom, filters?.dateTo) : null;
        if (prevRange) {
          // Si la comparación falla, el reporte sigue sin ella en vez de caerse.
          try {
            const prev = (await runWidgetQueryTool({ ...section, filters: { ...filters, ...prevRange } }, tenantId, ctx.timeZone)) as {
              data: ReportSection["data"];
            };
            previous = prev.data[0]?.value ?? 0;
          } catch (err) {
            console.error("[assistant] fallo la comparación con el periodo anterior:", err);
          }
        }

        return {
          kind,
          heading,
          field: section.field as string,
          aggregation: section.aggregation as string,
          groupBy,
          filters,
          data,
          previous,
        };
      } catch (err) {
        throw new Error(`sections[${i}] ("${heading}"): ${err instanceof Error ? err.message : "error desconocido"}`);
      }
    }),
  );

  ctx.report = { title, generatedAt: new Date().toISOString(), sections };
  return { ok: true, title, sections: sections.map((s) => ({ heading: s.heading, data: s.data, previous: s.previous })) };
}

type ToolContext = { report?: Report; timeZone?: string };

async function callTool(name: string, input: unknown, tenantId: string, ctx: ToolContext): Promise<unknown> {
  if (name === "build_report") return buildReportTool(input, tenantId, ctx);
  if (name === "run_widget_query") return runWidgetQueryTool(input, tenantId, ctx.timeZone);
  if (name === "list_tickets") return listTicketsTool(input, tenantId);
  throw new Error(`herramienta desconocida: "${name}"`);
}

type HistoryTurn = { role: "user" | "assistant"; text: string };
type Validation = { ok: true; question: string; history: HistoryTurn[]; timeZone?: string } | { ok: false; error: string };

// Memoria de conversación acotada: el cliente manda los últimos intercambios
// (los mismos que ya muestra en pantalla), el servidor los antepone al
// mensaje nuevo. A propósito NO viajan resultados de herramientas de turnos
// anteriores — cada pregunta nueva vuelve a consultar datos frescos en vez
// de confiar en un número que pudo haber cambiado desde entonces.
const MAX_HISTORY_TURNS = 6;
// Las respuestas del asistente (rol "assistant") pueden ser largas — análisis
// con listas, reportes — y el cliente las reenvía tal cual. Rechazarlas por
// pasar el tope de las preguntas rompía toda la conversación; se recortan.
const MAX_HISTORY_ASSISTANT_TEXT_LENGTH = 2000;

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
    const maxLength = role === "assistant" ? Infinity : MAX_QUESTION_LENGTH;
    if (typeof text !== "string" || text.trim().length === 0 || text.length > maxLength) {
      return { ok: false, error: `history[${i}].text inválido` };
    }
    history.push({ role: role as "user" | "assistant", text: text.trim().slice(0, role === "assistant" ? MAX_HISTORY_ASSISTANT_TEXT_LENGTH : MAX_QUESTION_LENGTH) });
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

  // Opcional: el navegador manda su zona IANA. Una inválida se ignora (UTC) en vez de rechazar la pregunta.
  const timeZone = typeof b.timeZone === "string" && isValidTimeZone(b.timeZone) ? b.timeZone : undefined;

  return { ok: true, question: question.trim(), history: historyValidation.history, timeZone };
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
 *
 * `toolCalls` lleva el input que armó el modelo y, si falló, el error que
 * recibió de vuelta — con solo el nombre de la herramienta (antes
 * `toolsUsed`) no había forma de saber desde este log por qué una
 * respuesta salió sin datos (caso "ventas de octubre" del 2026-10-16:
 * dos consultas fallidas que solo se veían cruzando con los console.error).
 */
type ToolCallLog = { name: string; input: unknown; error?: string };

function logQa(entry: {
  tenantId: string;
  question: string;
  answer: string;
  toolCalls: ToolCallLog[];
  turns: number;
  historyTurns: number;
}): void {
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
  const systemPrompt = buildSystemPrompt(new Date(), validation.timeZone);
  const tools = buildTools();
  const messages: Message[] = [
    ...validation.history.map((turn): Message => ({ role: turn.role, content: [{ text: turn.text }] })),
    { role: "user", content: [{ text: validation.question }] },
  ];
  // Para el log de auditoría al final — qué herramientas se invocaron y con
  // qué input, sin importar si tuvieron éxito (un intento de herramienta
  // inexistente también es una señal útil, ver logQa()).
  const toolCalls: ToolCallLog[] = [];
  const toolContext: ToolContext = { timeZone: validation.timeZone };

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await bedrock.send(
        new ConverseCommand({
          modelId,
          system: [{ text: systemPrompt }],
          messages,
          toolConfig: { tools },
          // Acotado a propósito (costo/latencia) — sección 10.1 de PROYECTO.md
          // ya mostró lo rápido que un costo "chico" escala sin límites explícitos.
          inferenceConfig: { maxTokens: 1024, temperature: 0.3 },
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
        logQa({ tenantId, question: validation.question, answer: text, toolCalls, turns: turn + 1, historyTurns: validation.history.length });
        if (!toolContext.report) return jsonResponse(200, { answer: text });
        // Si guardar falla, el reporte igual le llega al cliente (descargable en el momento), solo que no queda en "Reportes".
        let reportId: string | undefined;
        try {
          reportId = (await saveReport(tenantId, text, toolContext.report)).reportId;
        } catch (err) {
          console.error("[assistant] no se pudo guardar el reporte:", err);
        }
        return jsonResponse(200, { answer: text, report: toolContext.report, reportId });
      }

      const toolUseBlocks = (outputMessage.content ?? []).filter((block) => block.toolUse);
      const toolResultContent: ContentBlock[] = await Promise.all(
        toolUseBlocks.map(async (block): Promise<ContentBlock> => {
          const toolUse = block.toolUse!;
          const callLog: ToolCallLog = { name: toolUse.name ?? "(sin nombre)", input: toolUse.input };
          toolCalls.push(callLog);
          try {
            const result = await callTool(toolUse.name ?? "", toolUse.input, tenantId, toolContext);
            return {
              toolResult: { toolUseId: toolUse.toolUseId, content: [{ json: result as Record<string, unknown> }] },
            } as ContentBlock;
          } catch (err) {
            console.error(`[assistant] fallo la herramienta "${toolUse.name}":`, err);
            callLog.error = err instanceof Error ? err.message : "error desconocido";
            return {
              toolResult: {
                toolUseId: toolUse.toolUseId,
                content: [{ text: callLog.error }],
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
