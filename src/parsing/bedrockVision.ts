import { BedrockRuntimeClient, ConverseCommand, type ContentBlock } from "@aws-sdk/client-bedrock-runtime";

import {
  isNotASale,
  type NotASale,
  parseTicketJson,
  sendWithThrottleRetry,
  sleep,
  TICKET_JSON_SHAPE,
} from "./bedrockShared.js";
import { reconcileWithTaxSection } from "./taxSection.js";
import type { ParsedTicket } from "./types.js";

const bedrock = new BedrockRuntimeClient({});

/** Un ticket que ni Bedrock puede leer no debería costar más de esto en imágenes. */
const MAX_TILES = 12;

const SYSTEM_PROMPT = `Sos un extractor de datos de tickets y facturas de venta. Se te dan una o más imágenes que juntas forman UN ticket impreso, en franjas verticales de arriba hacia abajo (suele ser una factura electrónica colombiana de un POS como Loggro). Devolvé SOLO JSON, sin markdown ni texto extra, con esta forma exacta:

${TICKET_JSON_SHAPE}

Reglas estrictas:
- Números colombianos: el punto es separador de miles y la coma es decimal ("$ 6.100" = 6100). Todos los montos van como número entero sin símbolo ni separadores (6100, no "6.100" ni "$6.100").
- "items": una entrada por cada línea de PRODUCTO de la factura (no de la sección de impuestos). Tomá "quantity" de la columna Cantidad y "unitPrice" de la columna Precio de esa fila. "subtotal" = el valor de la columna Total/Importe de ESA MISMA fila; si esa columna no está o no se lee, usá quantity × unitPrice. Siempre tiene que cumplirse subtotal = quantity × unitPrice para cada ítem — si no da exacto, algo se leyó mal, revisá los tres valores de esa fila. "voided" true solo si la línea figura anulada.
- Primero fijate QUÉ documento es. Si NO es una factura de venta sino un reporte de caja — "Comprobante Informe Diario", "Informe Diario", "Cierre de caja", "Cuadre de caja", "Arqueo", "Informe Z" — respondé exactamente {"notASale":true}. Se reconoce porque en vez de productos con cantidad y precio lista medios de pago (Datafono, Efectivo, QR, Rappi) con "No. Trans." y el total vendido en el día. NUNCA conviertas esas filas en ítems: sumarían como venta el día entero otra vez.
- NUNCA metas como ítem un medio de pago ni las líneas que vienen DESPUÉS de "VALOR A PAGAR": "Efectivo" (el monto que pagó el cliente), "QR", "Datafono", "Tarjeta", "Nequi", "Daviplata", "Transferencia", "Cambio" (el vuelto), "Medio de pago", "Forma de pago", "Observaciones", "Atendido Por", "Mesa", el código QR o el CUFE. Esas no son productos — no tienen cantidad ni precio unitario real, y metidas como ítem rompen la cuenta. Ignoralas por completo.
- Sección de impuestos ("Impuestos", "IVA") con columnas Base e Impuesto: poné en "tax" el total de la columna Impuesto y en "taxBase" el total de la columna Base (los dos null si no hay esa sección). Son totales de TODA la factura: NUNCA los uses como "subtotal" ni "unitPrice" de un ítem, aunque coincidan con uno.
- En estas facturas el Precio y el Total de cada línea YA incluyen el IVA: la suma de los "subtotal" de los ítems es el VALOR A PAGAR, y Base + Impuesto = VALOR A PAGAR. Nunca le sumes el IVA a un precio ni al total.
- A veces un código de producto largo empuja las columnas Precio/Total fuera del papel y no se ven. Si pasa: con UNA sola línea de producto, su "subtotal" es el VALOR A PAGAR y "unitPrice" = VALOR A PAGAR / cantidad. Con VARIAS líneas, poné 0 en "unitPrice" y "subtotal" de las que no tengan precio visible — no repartas el total ni la Base entre ellas ni inventes precios.
- "total": copiá el valor final impreso ("VALOR A PAGAR", "TOTAL"), no lo calcules. El efectivo recibido y el cambio NUNCA forman parte de esta cuenta.
- "tax" / "discount" / "tip": número si aparecen explícitos, si no null.
- "timestamp": fecha y hora del ticket en ISO 8601, o null si no hay.
- Si las imágenes no son un ticket de venta legible, respondé exactamente {"unparseable":true}. No inventes valores que no estén en la imagen.
- Respondé SOLO el JSON.`;

/**
 * OCR + extracción de un ticket que el POS imprimió como imagen. Recibe las
 * franjas PNG ya reconstruidas (`escpos.extractRasterTiles`). Devuelve
 * `null` (nunca lanza por una imagen que no pudo leer) para que el llamador
 * lo trate igual que cualquier otro parseo que no matcheó, o `NotASale` si
 * la imagen es un reporte de caja y no una venta. Lo que devuelve el modelo
 * pasa por `reconcileWithTaxSection` antes de salir. El throttling se
 * reintenta acá mismo (ver `bedrockShared.ts`).
 */
export async function tryBedrockVision(
  pngTiles: Buffer[],
  modelId: string,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<ParsedTicket | NotASale | null> {
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
  const result = text ? parseTicketJson(text) : null;
  return result === null || isNotASale(result) ? result : reconcileWithTaxSection(result);
}
