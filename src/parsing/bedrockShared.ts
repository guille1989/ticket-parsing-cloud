import type { ParsedItem, ParsedTicket } from "./types.js";

/**
 * Forma exacta que se le pide al modelo (texto o imagen). El prompt vive en
 * cada llamador; acá está lo compartido: reintento por throttling y el
 * parseo/validación del JSON que devuelve.
 */
export const TICKET_JSON_SHAPE =
  '{"items":[{"description":string,"quantity":number,"unitPrice":number,"subtotal":number,"voided":boolean}],"total":number,"tax":number|null,"taxBase":number|null,"discount":number|null,"tip":number|null,"timestamp":string|null}';

/**
 * El modelo leyó bien el documento pero no es una venta — típicamente el
 * "Comprobante Informe Diario" (cierre de caja) de Loggro, que lista los
 * medios de pago del día (Efectivo, QR, Datafono...) con su cantidad de
 * transacciones y total. Distinto de `null` (no se pudo leer) para que el
 * llamador lo marque con un motivo claro y no como un error de OCR.
 */
export interface NotASale {
  notASale: true;
}

export const NOT_A_SALE: NotASale = { notASale: true };

export function isNotASale(result: ParsedTicket | NotASale | null): result is NotASale {
  return result !== null && "notASale" in result;
}

/**
 * Líneas que el modelo a veces devuelve como ítem pero nunca son un
 * producto: medios de pago (el "Efectivo" recibido, "QR", "Datafono"...),
 * vuelto y totales. Se compara contra la descripción ENTERA normalizada
 * (ver `normalizeDescription`), no por substring — "Empanada Efectivo" o
 * "DIARIO" (un producto real de Empanadas Típicas) no matchean.
 */
const PAYMENT_METHOD =
  "(?:efectivo|qr|codigo qr|datafono|tarjeta(?: (?:de )?(?:credito|debito))?|credito|debito|nequi|daviplata|transferencia(?: bancaria)?|bancolombia|rappi)";
const NON_PRODUCT_LINE = new RegExp(
  `^(?:(?:(?:medio|forma) de )?pago(?: (?:con|en|por))? )?${PAYMENT_METHOD}$` +
    "|^(?:cambio|vuelto|medio de pago|forma de pago|sub ?total|total)$",
);

function normalizeDescription(description: string): string {
  return description
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ") // "Total (Prop. Incluida)" -> "total"
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isNonProductLine(description: string): boolean {
  return NON_PRODUCT_LINE.test(normalizeDescription(description));
}

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000];

/**
 * La cuota de Bedrock (RPM) es por cuenta, no por tenant — con varios
 * negocios subiendo tickets que le pegan al modelo al mismo tiempo, es
 * fácil chocar contra el límite. Además de `ThrottlingException`, la cuota
 * agotada a veces se reporta como `AccessDeniedException` con un mensaje
 * sobre AWS Marketplace — sin este chequeo de texto, ese caso quedaría sin
 * distinguirse de un error de permisos real (que no tiene sentido
 * reintentar).
 */
export function isThrottling(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "ThrottlingException") return true;
  return err.name === "AccessDeniedException" && /aws-marketplace/i.test(err.message);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Corre `send` reintentando SOLO ante throttling/cuota, con backoff corto,
 * dentro de la misma invocación del Lambda — así una ráfaga corta entre
 * tenants se resuelve acá en vez de depender de que el Stream reintente el
 * batch entero (que vuelve a leer S3/tenant de todos los registros). Otro
 * error (red, permisos reales) se propaga de una.
 */
export async function sendWithThrottleRetry<T>(
  send: () => Promise<T>,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (err) {
      if (!isThrottling(err) || attempt >= MAX_ATTEMPTS - 1) throw err;
      await wait(BACKOFF_MS[attempt]);
    }
  }
}

/**
 * Extrae y valida el JSON que devolvió el modelo. Devuelve `null` (nunca
 * lanza) si el texto no trae un JSON con la forma esperada o si el modelo
 * respondió `{"unparseable":true}` — el llamador lo trata igual que un
 * parser determinístico que no matcheó. `NOT_A_SALE` si el modelo respondió
 * `{"notASale":true}`, o si TODOS los ítems que devolvió son medios de
 * pago/totales (un cierre de caja que el modelo igual convirtió en ítems).
 */
export function parseTicketJson(text: string): ParsedTicket | NotASale | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }

  if (!raw || typeof raw !== "object") return null;
  if ("notASale" in raw && raw.notASale === true) return NOT_A_SALE;
  if ("unparseable" in raw) return null;

  return validateShape(raw as Record<string, unknown>);
}

function validateShape(raw: Record<string, unknown>): ParsedTicket | NotASale | null {
  if (!Array.isArray(raw.items) || raw.items.length === 0) return null;
  if (typeof raw.total !== "number" || !Number.isFinite(raw.total)) return null;

  const items: ParsedItem[] = [];
  for (const item of raw.items) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.description !== "string" ||
      typeof item.quantity !== "number" ||
      typeof item.unitPrice !== "number" ||
      typeof item.subtotal !== "number"
    ) {
      return null;
    }
    items.push({
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: item.subtotal,
      voided: Boolean(item.voided),
    });
  }

  // Se descartan acá, no en el chequeo de coherencia, porque un cierre de
  // caja con sus medios de pago como ítems es internamente coherente
  // (Efectivo + QR = total del día) y pasaría como venta. Si sacarlos deja
  // ítems reales, sigue el camino normal y la coherencia decide: un
  // "Efectivo" recibido metido de más en una factura real se descarta y la
  // venta se recupera.
  const products = items.filter((item) => !isNonProductLine(item.description));
  if (products.length === 0) return NOT_A_SALE;

  const timestamp =
    typeof raw.timestamp === "string" && !Number.isNaN(Date.parse(raw.timestamp))
      ? new Date(raw.timestamp).toISOString()
      : new Date().toISOString();

  return {
    items: products,
    total: raw.total,
    tax: typeof raw.tax === "number" ? raw.tax : undefined,
    taxBase: typeof raw.taxBase === "number" ? raw.taxBase : undefined,
    discount: typeof raw.discount === "number" ? raw.discount : undefined,
    tip: typeof raw.tip === "number" ? raw.tip : undefined,
    timestamp,
  };
}
