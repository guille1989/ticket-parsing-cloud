import { parseArMoney } from "../money.js";
import { ParsedItem, TicketParser } from "../types.js";

/**
 * Parser de EJEMPLO/PLANTILLA, portado desde print-capture-agent (donde se
 * había escrito y probado antes de migrar el parseo a la nube). Escrito
 * contra los tickets sintéticos de fixtures/sample-tickets — NO está
 * validado contra ningún POS real todavía.
 *
 * Referencia de la forma que debería tener cada parser nuevo: un `id`
 * único (el que cada tenant va a tener asignado en la tabla Tenants) +
 * extracción línea por línea con regex.
 */

const ITEM_LINE = /^\s*(\d+)\s+(.+?)\s{2,}(\d+)\s+(\d+)(\s+\*ANULADO\*)?\s*$/;
const DATE_LINE = /Fecha:\s*(\d{2})\/(\d{2})\/(\d{4}).*Hora:\s*(\d{2}):(\d{2})/;

export const example38ColParser: TicketParser = {
  id: "example-38col",

  parse(rawText) {
    const lines = rawText.split(/\r?\n/);
    const items: ParsedItem[] = [];
    let discount: number | undefined;
    let tip: number | undefined;
    let total: number | null = null;
    let timestamp = new Date().toISOString();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const dateMatch = line.match(DATE_LINE);
      if (dateMatch) {
        const [, dd, mm, yyyy, hh, min] = dateMatch;
        timestamp = new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00`).toISOString();
        continue;
      }

      const itemMatch = line.match(ITEM_LINE);
      if (itemMatch) {
        const [, qty, description, unitPrice, subtotal, voided] = itemMatch;
        items.push({
          quantity: Number(qty),
          description: description.trim(),
          unitPrice: Number(unitPrice),
          subtotal: Number(subtotal),
          voided: Boolean(voided),
        });
        continue;
      }

      if (trimmed.startsWith("TOTAL:")) {
        total = parseArMoney(trimmed.slice("TOTAL:".length));
        continue;
      }
      if (trimmed.startsWith("Descuento")) {
        discount = Math.abs(parseArMoney(trimmed.slice(trimmed.indexOf(":") + 1)));
        continue;
      }
      if (trimmed.startsWith("Propina")) {
        tip = parseArMoney(trimmed.slice(trimmed.indexOf(":") + 1));
        continue;
      }
    }

    if (total === null || items.length === 0) {
      return null;
    }

    return { items, discount, tip, total, timestamp };
  },
};
