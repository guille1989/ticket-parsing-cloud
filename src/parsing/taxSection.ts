import type { ParsedItem, ParsedTicket } from "./types.js";

/**
 * Descripción de la única línea que queda cuando los precios por producto
 * no se pueden leer. Fija a propósito (no "2× ALMO., 2× CAFE LECHE") para
 * que en ventas por producto todo lo no atribuible sume en UN renglón
 * visible, en vez de repartirse en productos con montos inventados.
 */
export const UNATTRIBUTED_DESCRIPTION = "Sin desglose (precios no legibles)";

const TOLERANCE_ABS = 1;

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= TOLERANCE_ABS;
}

/**
 * Corrige lo que el OCR de una factura colombiana impresa como imagen
 * (Loggro) arma mal con la sección de impuestos. En esas facturas el
 * Precio/Total de cada línea YA incluye el IVA y Base + Impuesto = VALOR A
 * PAGAR = suma de líneas. Cuando un código de producto largo empuja las
 * columnas Precio/Total fuera del papel, los precios por línea no están en
 * la imagen y el modelo los inventaba con Base e Impuesto:
 *
 * - 1 ítem con el total inflado: total = precio + IVA otra vez (6262 en una
 *   venta de 5400). Se corrige con Base + Impuesto impresos.
 * - 1 ítem a precio base (4454 en vez de 5300). Con una sola línea de
 *   producto, su total ES el VALOR A PAGAR.
 * - Varios ítems con la Base o el Impuesto como precio de un producto, la
 *   Base repartida entre productos, o precios en 0: el reparto no se puede
 *   saber, así que se guarda el total en una sola línea
 *   `UNATTRIBUTED_DESCRIPTION` — el total sigue sumando bien en ventas, sin
 *   inventarle montos a ningún producto.
 *
 * Solo corrige lo que se puede saber con exactitud cruzando números
 * impresos; lo demás lo sigue decidiendo `checkEconomicCoherence`. Las
 * correcciones de 1 ítem exigen `taxBase` (sin él, "precio a base" y "total
 * inflado" dan la misma cuenta y no se distinguen). Con descuento o propina
 * no toca nada: no sabemos cómo los compone el POS con la Base.
 *
 * Es solo para el camino de imagen: un POS de texto puede imprimir líneas
 * sin IVA, y ahí "ítems = Base" es correcto.
 */
export function reconcileWithTaxSection(ticket: ParsedTicket): ParsedTicket {
  const { tax, taxBase } = ticket;
  // Con un impuesto dentro de la tolerancia, "suma = Base" y "suma = total"
  // serían indistinguibles.
  if (tax === undefined || tax <= TOLERANCE_ABS || ticket.discount !== undefined || ticket.tip !== undefined) {
    return ticket;
  }

  const products = ticket.items.filter((item) => !item.voided);
  const productsSum = products.reduce((sum, item) => sum + item.subtotal, 0);
  let total = ticket.total;

  // El modelo le volvió a sumar el IVA al total: los ítems ya dan Base +
  // Impuesto (lo impreso) y solo el total no.
  if (taxBase !== undefined && !near(total, taxBase + tax) && near(productsSum, taxBase + tax)) {
    total = taxBase + tax;
  }

  if (products.length === 1) {
    const [item] = products;
    const totalConfirmed = taxBase !== undefined && near(total, taxBase + tax);
    if (totalConfirmed && !near(item.subtotal, total) && (near(item.subtotal, taxBase) || item.subtotal === 0)) {
      return { ...ticket, total, items: [{ ...item, subtotal: total, unitPrice: total / item.quantity }] };
    }
    return { ...ticket, total };
  }

  if (products.length >= 2) {
    const base = taxBase ?? total - tax;
    const printedTotal = taxBase !== undefined ? taxBase + tax : total;
    const taxSectionLeaked = products.some(
      (item) => Math.round(item.subtotal) === Math.round(tax) || near(item.subtotal, base),
    );
    const sumsToBase = near(productsSum, base);
    const unreadablePrices = products.some((item) => item.subtotal === 0) && !near(productsSum, printedTotal);
    if (taxSectionLeaked || sumsToBase || unreadablePrices) {
      const unattributed: ParsedItem = {
        description: UNATTRIBUTED_DESCRIPTION,
        quantity: 1,
        unitPrice: total,
        subtotal: total,
        voided: false,
      };
      return { ...ticket, total, items: [unattributed] };
    }
  }

  return { ...ticket, total };
}
