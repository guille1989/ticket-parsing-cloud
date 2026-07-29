import type { ParsedTicket } from "./types.js";

export type CoherenceResult = { ok: true } | { ok: false; reason: string };

/**
 * Tolerancia para redondeo de centavos, no para tapar errores reales — un
 * ticket real puede tener un centavo de diferencia entre lo que imprime la
 * impresora y la suma exacta de sus líneas (redondeo de IVA, por ejemplo).
 * Ninguno de los dos caminos de parseo (regex determinístico ni el fallback
 * de Bedrock) verifica que los números cierren entre sí — sin este chequeo,
 * un total o un subtotal inventado pasaría igual como `status: "parsed"`.
 */
const TOLERANCE_ABS = 1;

/**
 * Techos elegidos junto al negocio, no un valor técnico — muy por encima de
 * los tickets reales vistos hasta ahora ($900-$12.300), pero suficientes
 * para cortar una alucinación tipo "$99.999.999" o un array de miles de
 * ítems sin rechazar un ticket grande legítimo.
 */
const MAX_ITEMS = 50;
const MAX_AMOUNT_ARS = 500_000;

function withinTolerance(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= TOLERANCE_ABS;
}

export function checkEconomicCoherence(ticket: ParsedTicket): CoherenceResult {
  if (!Number.isFinite(ticket.total)) {
    return { ok: false, reason: `total no es un número finito (${ticket.total})` };
  }
  if (ticket.total < 0) {
    return { ok: false, reason: `total negativo (${ticket.total})` };
  }
  if (ticket.total > MAX_AMOUNT_ARS) {
    return { ok: false, reason: `total (${ticket.total}) supera el techo razonable de ${MAX_AMOUNT_ARS}` };
  }
  if (ticket.items.length === 0) {
    return { ok: false, reason: "el ticket no tiene ítems" };
  }
  if (ticket.items.length > MAX_ITEMS) {
    return { ok: false, reason: `demasiados ítems (${ticket.items.length}), máximo razonable ${MAX_ITEMS}` };
  }

  for (const item of ticket.items) {
    if (item.description.trim().length === 0) {
      return { ok: false, reason: "un ítem tiene descripción vacía" };
    }
    if (!Number.isFinite(item.quantity) || !Number.isFinite(item.unitPrice) || !Number.isFinite(item.subtotal)) {
      return { ok: false, reason: `valores no finitos en "${item.description}"` };
    }
    if (item.quantity <= 0) {
      return { ok: false, reason: `cantidad inválida (${item.quantity}) en "${item.description}"` };
    }
    if (item.unitPrice < 0 || item.subtotal < 0) {
      return { ok: false, reason: `precio o subtotal negativo en "${item.description}"` };
    }
    if (item.unitPrice > MAX_AMOUNT_ARS) {
      return { ok: false, reason: `precio unitario de "${item.description}" (${item.unitPrice}) supera el techo razonable de ${MAX_AMOUNT_ARS}` };
    }
    if (item.subtotal > MAX_AMOUNT_ARS) {
      return { ok: false, reason: `subtotal de "${item.description}" (${item.subtotal}) supera el techo razonable de ${MAX_AMOUNT_ARS}` };
    }
    const expectedSubtotal = item.quantity * item.unitPrice;
    if (!withinTolerance(item.subtotal, expectedSubtotal)) {
      return {
        ok: false,
        reason:
          `el subtotal de "${item.description}" (${item.subtotal}) no coincide con ` +
          `cantidad × precio unitario (${expectedSubtotal})`,
      };
    }
  }

  // Los ítems *ANULADO* (cancelados) no suman al total — ver
  // fixtures/sample-tickets/05-item-anulado.txt, donde el total impreso ya
  // los excluye.
  const itemsSum = ticket.items.filter((item) => !item.voided).reduce((sum, item) => sum + item.subtotal, 0);
  if (ticket.discount !== undefined) {
    if (!Number.isFinite(ticket.discount) || ticket.discount < 0) {
      return { ok: false, reason: `descuento inválido (${ticket.discount})` };
    }
    if (ticket.discount > MAX_AMOUNT_ARS || ticket.discount > itemsSum) {
      return { ok: false, reason: `descuento (${ticket.discount}) supera el máximo permitido para esta venta` };
    }
  }
  if (ticket.tip !== undefined) {
    if (!Number.isFinite(ticket.tip) || ticket.tip < 0) {
      return { ok: false, reason: `propina inválida (${ticket.tip})` };
    }
    if (ticket.tip > MAX_AMOUNT_ARS) {
      return { ok: false, reason: `propina (${ticket.tip}) supera el techo razonable de ${MAX_AMOUNT_ARS}` };
    }
  }
  const expectedTotal = itemsSum - (ticket.discount ?? 0) + (ticket.tip ?? 0);
  if (!withinTolerance(ticket.total, expectedTotal)) {
    return {
      ok: false,
      reason: `el total (${ticket.total}) no coincide con la suma de ítems ajustada por descuento/propina (${expectedTotal})`,
    };
  }

  return { ok: true };
}
