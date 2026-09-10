import type { ParsedItem, ParsedTicket } from "./types.js";

/**
 * Forma exacta que se le pide al modelo (texto o imagen). El prompt vive en
 * cada llamador; acá está lo compartido: reintento por throttling y el
 * parseo/validación del JSON que devuelve.
 */
export const TICKET_JSON_SHAPE =
  '{"items":[{"description":string,"quantity":number,"unitPrice":number,"subtotal":number,"voided":boolean}],"total":number,"tax":number|null,"discount":number|null,"tip":number|null,"timestamp":string|null}';

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
 * parser determinístico que no matcheó.
 */
export function parseTicketJson(text: string): ParsedTicket | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }

  if (!raw || typeof raw !== "object" || "unparseable" in raw) return null;

  return validateShape(raw as Record<string, unknown>);
}

function validateShape(raw: Record<string, unknown>): ParsedTicket | null {
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

  const timestamp =
    typeof raw.timestamp === "string" && !Number.isNaN(Date.parse(raw.timestamp))
      ? new Date(raw.timestamp).toISOString()
      : new Date().toISOString();

  return {
    items,
    total: raw.total,
    tax: typeof raw.tax === "number" ? raw.tax : undefined,
    discount: typeof raw.discount === "number" ? raw.discount : undefined,
    tip: typeof raw.tip === "number" ? raw.tip : undefined,
    timestamp,
  };
}
