// Conversación del asistente de datos (vista IA del dashboard). Se guarda para que un
// refresh de la página (o abrir la app en otro dispositivo) no pierda el hilo. Como los
// reportes, vence sola: cada item lleva un TTL y DynamoDB lo borra (puede demorar hasta
// ~48 h, por eso las lecturas también filtran por `ttl`).
export const CONVERSATION_RETENTION_DAYS = 30;

// Un item de DynamoDB admite 400 KB: se corta antes, con margen para el resto de atributos.
export const MAX_MESSAGES = 100;
export const MAX_TEXT_LENGTH = 20_000;
export const MAX_BODY_BYTES = 300_000;
// Debe coincidir con MAX_HISTORY_TURNS en assistant/askHandler.ts.
export const MAX_HISTORY_TURNS = 6;

// ISO de creación + sufijo, igual que el reportId: la última conversación creada es la última por SK.
const CONVERSATION_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z_[0-9a-f]{8}$/;

export interface StoredMessage {
  role: "user" | "ai";
  text: string;
  /** Reporte guardado (reports/*) que acompaña la respuesta: el dashboard lo abre al restaurar. */
  reportId?: string;
}

export interface StoredHistoryTurn {
  role: "user" | "assistant";
  text: string;
}

export interface StoredConversationItem {
  pk: string;
  sk: string;
  conversationId: string;
  messages: StoredMessage[];
  history: StoredHistoryTurn[];
  createdAt: string;
  updatedAt: string;
  /** Epoch en segundos: atributo TTL de DynamoDB. */
  ttl: number;
}

export function isValidConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID_PATTERN.test(value);
}

type Validation = { ok: true; messages: StoredMessage[]; history: StoredHistoryTurn[] } | { ok: false; error: string };

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT_LENGTH;
}

export function validateConversationBody(body: unknown): Validation {
  if (!body || typeof body !== "object") return { ok: false, error: "body inválido, se esperaba un objeto JSON" };
  const { messages, history } = body as Record<string, unknown>;

  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
    return { ok: false, error: `messages debe ser una lista de 1 a ${MAX_MESSAGES} mensajes` };
  }
  const cleanMessages: StoredMessage[] = [];
  for (const raw of messages) {
    const m = raw as Record<string, unknown> | null;
    if (!m || typeof m !== "object" || (m.role !== "user" && m.role !== "ai") || !isText(m.text)) {
      return { ok: false, error: `cada mensaje necesita role "user"|"ai" y text de hasta ${MAX_TEXT_LENGTH} caracteres` };
    }
    if (m.reportId !== undefined && (typeof m.reportId !== "string" || !m.reportId || m.reportId.length > 100)) {
      return { ok: false, error: "reportId inválido" };
    }
    cleanMessages.push({ role: m.role, text: m.text, ...(m.reportId ? { reportId: m.reportId as string } : {}) });
  }

  if (!Array.isArray(history) || history.length > MAX_HISTORY_TURNS) {
    return { ok: false, error: `history debe ser una lista de hasta ${MAX_HISTORY_TURNS} turnos` };
  }
  const cleanHistory: StoredHistoryTurn[] = [];
  for (const raw of history) {
    const t = raw as Record<string, unknown> | null;
    if (!t || typeof t !== "object" || (t.role !== "user" && t.role !== "assistant") || !isText(t.text)) {
      return { ok: false, error: `cada turno necesita role "user"|"assistant" y text de hasta ${MAX_TEXT_LENGTH} caracteres` };
    }
    cleanHistory.push({ role: t.role, text: t.text });
  }

  return { ok: true, messages: cleanMessages, history: cleanHistory };
}
