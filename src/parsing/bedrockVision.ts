import { BedrockRuntimeClient, ConverseCommand, type ContentBlock } from "@aws-sdk/client-bedrock-runtime";

import { parseTicketJson, sendWithThrottleRetry, sleep, TICKET_JSON_SHAPE } from "./bedrockShared.js";
import type { ParsedTicket } from "./types.js";

const bedrock = new BedrockRuntimeClient({});

/** Un ticket que ni Bedrock puede leer no debería costar más de esto en imágenes. */
const MAX_TILES = 12;

const SYSTEM_PROMPT = `Sos un extractor de datos de tickets y facturas de venta. Se te dan una o más imágenes que juntas forman UN ticket impreso, en franjas verticales de arriba hacia abajo (suele ser una factura electrónica colombiana de un POS como Loggro). Devolvé SOLO JSON, sin markdown ni texto extra, con esta forma exacta:

${TICKET_JSON_SHAPE}

Reglas estrictas:
- Números colombianos: el punto es separador de miles y la coma es decimal ("$ 6.100" = 6100). Todos los montos van como número entero sin símbolo ni separadores (6100, no "6.100" ni "$6.100").
- "items": una entrada por cada línea de PRODUCTO de la factura (no de la sección de impuestos). Tomá "quantity" de la columna Cantidad y "unitPrice" de la columna Precio de esa fila. "subtotal" = el valor de la columna Total/Importe de la fila; si esa columna no está o no se lee, usá quantity × unitPrice. "voided" true solo si la línea figura anulada.
- NUNCA metas como ítem las líneas que vienen DESPUÉS de "VALOR A PAGAR": "Efectivo" (el monto que pagó el cliente), "Cambio" (el vuelto), "Medio de pago", "Forma de pago", "Tarjeta", "Observaciones", "Atendido Por", "Mesa", el QR o el CUFE. Esas no son productos — no tienen cantidad ni precio unitario real, y metidas como ítem rompen la cuenta. Ignoralas por completo.
- Si la factura tiene una sección de impuestos ("Impuestos", "IVA") con columnas Base e Impuesto: poné en "tax" el total de la columna Impuesto. Si NO podés leer los precios por línea (columna Precio/Total cortada o ilegible) pero sí ves esa Base, entonces la suma de los "subtotal" de los ítems debe dar la Base (precio sin IVA), y "total" = Base + Impuesto = "VALOR A PAGAR".
- "total": el valor final a pagar ("VALOR A PAGAR", "TOTAL"). Debe cumplirse: suma de subtotales de ítems = total, O bien suma de subtotales + tax = total. El efectivo recibido y el cambio NUNCA forman parte de esta cuenta.
- "tax" / "discount" / "tip": número si aparecen explícitos, si no null.
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
