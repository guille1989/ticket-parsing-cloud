import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

import { parseTicketJson, sendWithThrottleRetry, sleep, TICKET_JSON_SHAPE } from "./bedrockShared.js";
import type { ParsedTicket } from "./types.js";

const bedrock = new BedrockRuntimeClient({});

/**
 * Se le pide al modelo que devuelva "unparseable" en vez de inventar datos
 * cuando no está seguro — un LLM completa gustoso cualquier forma que se le
 * pida, así que sin esta salida de escape terminaría alucinando items/total
 * para textos que en realidad no son un ticket.
 */
const SYSTEM_PROMPT = `Sos un extractor de datos de tickets de venta para un negocio. Se te da el texto crudo que emitió una impresora o datáfono — puede tener ruido, códigos de control, o un formato que no reconocés. Tu única tarea es devolver JSON, sin texto adicional ni markdown, con esta forma exacta:

${TICKET_JSON_SHAPE}

Reglas estrictas:
- Si no podés identificar con confianza al menos un ítem y un total, respondé exactamente {"unparseable":true} — no inventes valores que no estén claramente en el texto.
- Montos como número entero sin símbolo ni separador de miles.
- NUNCA metas como ítem las líneas de pago que suelen venir después del total: "Efectivo" (lo que pagó el cliente), "Cambio"/"Vuelto", "Medio de pago", "Tarjeta". No son productos, no tienen cantidad ni precio unitario real.
- "tax": el impuesto/IVA total si el ticket lo desglosa, si no null. Debe cumplirse: suma de subtotales de ítems = total, O suma de subtotales + tax = total. El efectivo recibido y el cambio nunca forman parte de esta cuenta.
- "timestamp" en ISO 8601 si hay fecha/hora en el texto, si no null.
- Respondé SOLO el JSON.`;

/**
 * Segundo intento de parseo cuando el parser determinístico del tenant no
 * reconoció el formato del ticket de TEXTO. Devuelve `null` (nunca lanza por
 * un texto que no pudo interpretar) para que el llamador lo trate igual que
 * un parser determinístico que no matcheó. El throttling se reintenta acá
 * mismo (ver `bedrockShared.ts`).
 */
export async function tryBedrockFallback(
  rawText: string,
  modelId: string,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<ParsedTicket | null> {
  const response = await sendWithThrottleRetry(
    () =>
      bedrock.send(
        new ConverseCommand({
          modelId,
          system: [{ text: SYSTEM_PROMPT }],
          messages: [{ role: "user", content: [{ text: rawText }] }],
          inferenceConfig: { maxTokens: 1024, temperature: 0 },
        }),
      ),
    wait,
  );

  const text = response.output?.message?.content?.find((block) => typeof block.text === "string")?.text;
  return text ? parseTicketJson(text) : null;
}
