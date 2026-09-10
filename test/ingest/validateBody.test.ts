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

test("rechaza port vacío, demasiado largo, con comillas/barra invertida o con caracteres de control", () => {
  expect(validateBody({ ...VALID_BODY, port: "" }).ok).toBe(false);
  expect(validateBody({ ...VALID_BODY, port: "X".repeat(101) }).ok).toBe(false);
  expect(validateBody({ ...VALID_BODY, port: 'impresora "rara"' }).ok).toBe(false);
  expect(validateBody({ ...VALID_BODY, port: "carpeta\\rara" }).ok).toBe(false);
  expect(validateBody({ ...VALID_BODY, port: "com\n3" }).ok).toBe(false);
});

test("acepta identificadores de puerto y también nombres de impresora (con espacios y paréntesis)", () => {
  expect(validateBody({ ...VALID_BODY, port: "COM3" }).ok).toBe(true);
  expect(validateBody({ ...VALID_BODY, port: "datafono-caja1" }).ok).toBe(true);
  expect(validateBody({ ...VALID_BODY, port: "periferico_1.2" }).ok).toBe(true);
  expect(validateBody({ ...VALID_BODY, port: "EPSON TM-T20II Receipt" }).ok).toBe(true);
  expect(validateBody({ ...VALID_BODY, port: "HP LaserJet Pro (copia 1)" }).ok).toBe(true);
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

// --- captura de spool: bytes ESC/POS en base64 ---

const { rawText: _t, ...BASE_NO_RAW } = VALID_BODY;
const escposBase64 = Buffer.from("\x1b@EMPANADAS\nTOTAL 6000\x1dV\x00", "latin1").toString("base64");

test("acepta rawBase64 + rawEncoding escpos, y expone los bytes decodificados", () => {
  const result = validateBody({ ...BASE_NO_RAW, rawBase64: escposBase64, rawEncoding: "escpos" });
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.rawKind).toBe("escpos");
    expect(Buffer.isBuffer(result.value.rawContent)).toBe(true);
    expect((result.value.rawContent as Buffer).toString("latin1")).toContain("EMPANADAS");
  }
});

test("rechaza mandar rawText y rawBase64 a la vez, o ninguno de los dos", () => {
  expect(validateBody({ ...VALID_BODY, rawBase64: escposBase64, rawEncoding: "escpos" }).ok).toBe(false);
  expect(validateBody(BASE_NO_RAW).ok).toBe(false);
});

test("rechaza rawBase64 sin rawEncoding, o con un rawEncoding que no es escpos", () => {
  expect(validateBody({ ...BASE_NO_RAW, rawBase64: escposBase64 }).ok).toBe(false);
  expect(validateBody({ ...BASE_NO_RAW, rawBase64: escposBase64, rawEncoding: "text" }).ok).toBe(false);
});

test("rechaza rawBase64 que no es base64 canónico", () => {
  expect(validateBody({ ...BASE_NO_RAW, rawBase64: "no es base64!!", rawEncoding: "escpos" }).ok).toBe(false);
  expect(validateBody({ ...BASE_NO_RAW, rawBase64: "abc", rawEncoding: "escpos" }).ok).toBe(false); // largo no múltiplo de 4
});

test("rechaza rawBase64 que decodifica por encima del límite de 6 MB", () => {
  const tooBig = Buffer.alloc(6 * 1024 * 1024 + 3).toString("base64");
  expect(validateBody({ ...BASE_NO_RAW, rawBase64: tooBig, rawEncoding: "escpos" }).ok).toBe(false);
});
