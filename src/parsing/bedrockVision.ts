import { BedrockRuntimeClient, ConverseCommand, type ContentBlock } from "@aws-sdk/client-bedrock-runtime";

import { parseTicketJson, sendWithThrottleRetry, sleep, TICKET_JSON_SHAPE } from "./bedrockShared.js";
import type { ParsedTicket } from "./types.js";

const bedrock = new BedrockRuntimeClient({});

/** Un ticket que ni Bedrock puede leer no debería costar más de esto en imágenes. */
const MAX_TILES = 12;

const SYSTEM_PROMPT = `Sos un extractor de datos de tickets y facturas de venta. Se te dan una o más imágenes que juntas forman UN ticket impreso, en franjas verticales de arriba hacia abajo (puede ser una factura electrónica colombiana de un POS como Loggro). Devolvé SOLO JSON, sin markdown ni texto extra, con esta forma exacta:

${TICKET_JSON_SHAPE}

Reglas estrictas:
- Números colombianos: el punto es separador de miles y la coma es decimal ("$ 6.100" = 6100). "unitPrice", "subtotal", "total", "discount" y "tip" van como número sin símbolo ni separadores (6100, no "6.100" ni "$6.100").
- "items": una entrada por línea de producto de la factura. Tomá "quantity" y "unitPrice" de la fila; "subtotal" = quantity × unitPrice salvo que la fila muestre otro valor. "voided" true solo si la línea figura anulada.
- "total": el valor final a pagar del ticket ("VALOR A PAGAR", "TOTAL").
- "discount" / "tip": número si aparecen explícitos, si no null.
- "timestamp": fecha y hora del ticket en ISO 8601, o null si no hay.
- Si las imágenes no son un ticket de venta legible, respondé exactamente {"unparseable":true}. No inventes valores que no estén en la imagen.
- Respondé SOLO el JSON.`;

/**
 * OCR + extracción de un ticket que el POS imprimió como imagen. Recibe las
 * franjas PNG ya reconstruidas (`escpos.extractRasterTiles`). Devuelve
 * `null` (nunca lanza por una imagen que no pudo leer) para que el llamador
 * lo trate igual que cualquier otro parseo que no matcheó. El throttling se
 * reintenta acá mismo (ver `bedrockShared.ts`).
 */
export async function tryBedrockVision(
  pngTiles: Buffer[],
  modelId: string,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<ParsedTicket | null> {
  if (pngTiles.length === 0) return null;

  const content: ContentBlock[] = [
    { text: "Extraé los datos de este ticket. Las imágenes son franjas verticales del mismo ticket, en orden de arriba hacia abajo." },
    ...pngTiles.slice(0, MAX_TILES).map<ContentBlock>((bytes) => ({
      image: { format: "png", source: { bytes } },
    })),
  ];

  const response = await sendWithThrottleRetry(
    () =>
      bedrock.send(
        new ConverseCommand({
          modelId,
          system: [{ text: SYSTEM_PROMPT }],
          messages: [{ role: "user", content }],
          inferenceConfig: { maxTokens: 2048, temperature: 0 },
        }),
      ),
    wait,
  );

  const text = response.output?.message?.content?.find((block) => typeof block.text === "string")?.text;
  return text ? parseTicketJson(text) : null;
}
