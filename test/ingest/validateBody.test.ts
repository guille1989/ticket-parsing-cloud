import { validateBody } from "../../src/ingest/handler";

const VALID_BODY = {
  ticketId: "5f2b9c3a-1111-4444-8888-abcdefabcdef",
  port: "COM3",
  capturedAt: "2026-07-27T23:00:00.000Z",
  rawText: "un ticket cualquiera",
};

test("acepta un body bien formado", () => {
  const result = validateBody(VALID_BODY);
  expect(result.ok).toBe(true);
});

test("rechaza body que no es un objeto", () => {
  expect(validateBody(null).ok).toBe(false);
  expect(validateBody("string").ok).toBe(false);
  expect(validateBody(42).ok).toBe(false);
});

// El ticketId termina siendo parte de la key de S3
// (tenants/<tenant>/<ticketId>.txt) y del sort key de DynamoDB — no puede
// aceptar cualquier string.
test("rechaza ticketId que no tiene forma de UUID", () => {
  expect(validateBody({ ...VALID_BODY, ticketId: "../../../etc/passwd" }).ok).toBe(false);
  expect(validateBody({ ...VALID_BODY, ticketId: "no-es-un-uuid" }).ok).toBe(false);
  expect(validateBody({ ...VALID_BODY, ticketId: "" }).ok).toBe(false);
  expect(validateBody({ ...VALID_BODY, ticketId: 123 }).ok).toBe(false);
});

test("acepta ticketId con mayúsculas (UUID es case-insensitive)", () => {
  expect(validateBody({ ...VALID_BODY, ticketId: "5F2B9C3A-1111-4444-8888-ABCDEFABCDEF" }).ok).toBe(true);
});

test("rechaza port vacío, demasiado largo, o con caracteres fuera del charset permitido", () => {
  expect(validateBody({ ...VALID_BODY, port: "" }).ok).toBe(false);
  expect(validateBody({ ...VALID_BODY, port: "X".repeat(65) }).ok).toBe(false);
  expect(validateBody({ ...VALID_BODY, port: "COM3; DROP TABLE" }).ok).toBe(false);
  expect(validateBody({ ...VALID_BODY, port: "COM3 con espacio" }).ok).toBe(false);
});

test("acepta port con el charset permitido: letras, números, _, . y -", () => {
  expect(validateBody({ ...VALID_BODY, port: "COM3" }).ok).toBe(true);
  expect(validateBody({ ...VALID_BODY, port: "datafono-caja1" }).ok).toBe(true);
  expect(validateBody({ ...VALID_BODY, port: "periferico_1.2" }).ok).toBe(true);
});

// capturedAt compone el sort key de DynamoDB — una fecha inválida rompe
// el orden cronológico de todo el tenant, no solo de este ticket.
test("rechaza capturedAt que no es exactamente ISO-8601 con milisegundos y Z", () => {
  expect(validateBody({ ...VALID_BODY, capturedAt: "27/07/2026" }).ok).toBe(false);
  expect(validateBody({ ...VALID_BODY, capturedAt: "2026-07-27" }).ok).toBe(false);
  expect(validateBody({ ...VALID_BODY, capturedAt: "2026-07-27T23:00:00Z" }).ok).toBe(false); // sin ms
  expect(validateBody({ ...VALID_BODY, capturedAt: "not a date" }).ok).toBe(false);
});

test("acepta capturedAt en el formato exacto de Date.toISOString()", () => {
  expect(validateBody({ ...VALID_BODY, capturedAt: new Date().toISOString() }).ok).toBe(true);
});

test("rechaza rawText vacío o ausente", () => {
  expect(validateBody({ ...VALID_BODY, rawText: "" }).ok).toBe(false);
  const { rawText: _omit, ...withoutRawText } = VALID_BODY;
  expect(validateBody(withoutRawText).ok).toBe(false);
});

test("rechaza rawText que supera el límite de tamaño", () => {
  expect(validateBody({ ...VALID_BODY, rawText: "X".repeat(64 * 1024 + 1) }).ok).toBe(false);
});

test("acepta rawText justo en el límite de tamaño", () => {
  expect(validateBody({ ...VALID_BODY, rawText: "X".repeat(64 * 1024) }).ok).toBe(true);
});
