import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

import type { ParsedItem, ParsedTicket } from "./types.js";

const bedrock = new BedrockRuntimeClient({});

/**
 * Se le pide al modelo que devuelva "unparseable" en vez de inventar datos
 * cuando no está seguro — un LLM completa gustoso cualquier forma que se le
 * pida, así que sin esta salida de escape terminaría alucinando items/total
 * para textos que en realidad no son un ticket.
 */
const SYSTEM_PROMPT = `Sos un extractor de datos de tickets de venta para un negocio. Se te da el texto crudo que emitió una impresora o datáfono — puede tener ruido, códigos de control, o un formato que no reconocés. Tu única tarea es devolver JSON, sin texto adicional ni markdown, con esta forma exacta:

{"items":[{"description":string,"quantity":number,"unitPrice":number,"subtotal":number,"voided":boolean}],"total":number,"discount":number|null,"tip":number|null,"timestamp":string|null}

Reglas estrictas:
- Si no podés identificar con confianza al menos un ítem y un total, respondé exactamente {"unparseable":true} — no inventes valores que no estén claramente en el texto.
- "timestamp" en ISO 8601 si hay fecha/hora en el texto, si no null.
- Respondé SOLO el JSON.`;

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000];

/**
 * La cuota de Bedrock (RPM) es por cuenta, no por tenant — con varios
 * negocios subiendo tickets que le pegan al fallback al mismo tiempo, es
 * fácil chocar contra el límite aunque cada uno individualmente esté lejos
 * de agotarlo. Se vio en pruebas reales que además de `ThrottlingException`,
 * la cuota agotada a veces se reporta como `AccessDeniedException` con un
 * mensaje sobre AWS Marketplace — sin este chequeo de texto, ese caso
 * quedaría sin distinguirse de un error de permisos real (que no tiene
 * sentido reintentar).
 */
function isThrottling(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "ThrottlingException") return true;
  return err.name === "AccessDeniedException" && /aws-marketplace/i.test(err.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Segundo intento de parseo cuando el parser determinístico del tenant no
 * reconoció el formato. Devuelve `null` (nunca lanza por un texto que no
 * pudo interpretar) para que el llamador lo trate igual que un parser
 * determinístico que no matcheó.
 *
 * Un throttling/cuota agotada se reintenta acá mismo (con backoff corto)
 * antes de propagarse — así una ráfaga corta entre tenants se resuelve
 * dentro de esta misma invocación en vez de depender de que el Stream
 * reintente el batch entero (que vuelve a leer S3/tenant de todos los
 * registros del batch, no solo el que chocó con el límite). Cualquier otro
 * error (red, permisos reales) se propaga de una, sin reintentar acá — eso
 * sigue siendo responsabilidad del Stream, igual que cualquier otro error
 * transitorio de este Lambda.
 */
export async function tryBedrockFallback(
  rawText: string,
  modelId: string,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<ParsedTicket | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await bedrock.send(
        new ConverseCommand({
          modelId,
          system: [{ text: SYSTEM_PROMPT }],
          messages: [{ role: "user", content: [{ text: rawText }] }],
          inferenceConfig: { maxTokens: 1024, temperature: 0 },
        }),
      );

      const content = response.output?.message?.content;
      const text = content?.find((block) => typeof block.text === "string")?.text;
      if (!text) return null;

      return parseModelJson(text);
    } catch (err) {
      if (!isThrottling(err) || attempt >= MAX_ATTEMPTS - 1) throw err;
      await wait(BACKOFF_MS[attempt]);
    }
  }
}

function parseModelJson(text: string): ParsedTicket | null {
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
    discount: typeof raw.discount === "number" ? raw.discount : undefined,
    tip: typeof raw.tip === "number" ? raw.tip : undefined,
    timestamp,
  };
}
