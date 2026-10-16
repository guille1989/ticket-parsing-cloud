import { isNonProductLine, isNotASale, NOT_A_SALE, parseTicketJson } from "../../src/parsing/bedrockShared";
import { checkEconomicCoherence } from "../../src/parsing/economicCoherence";
import type { ParsedTicket } from "../../src/parsing/types";

function item(description: string, quantity: number, unitPrice: number, subtotal = quantity * unitPrice) {
  return { description, quantity, unitPrice, subtotal, voided: false };
}

function modelJson(items: ReturnType<typeof item>[], total: number, tax: number | null = null) {
  return JSON.stringify({ items, total, tax, discount: null, tip: null, timestamp: "2026-10-06T21:14:08.000Z" });
}

function asTicket(result: ReturnType<typeof parseTicketJson>): ParsedTicket {
  if (result === null || isNotASale(result)) throw new Error(`se esperaba un ticket, vino ${JSON.stringify(result)}`);
  return result;
}

describe("cierre de caja de Loggro (Comprobante Informe Diario)", () => {
  // Lo que Bedrock devolvió para el ticket 29f179a5 (2026-10-07) de
  // Empanadas Típicas: las filas "Ventas" por medio de pago convertidas en
  // ítems. Cierra perfecto (216500 + 21800 = 238300) y por eso pasaba la
  // coherencia y entraba como UNA venta con el total del día entero.
  const cierreItems = [item("Efectivo", 23, 9413, 216500), item("QR", 2, 10900, 21800)];
  const cierreComoItems = modelJson(cierreItems, 238300, 36483);

  test("la versión vieja pasaba la coherencia: el chequeo económico solo no alcanza", () => {
    const ticketCrudo: ParsedTicket = { items: cierreItems, total: 238300, tax: 36483, timestamp: "2026-10-06T21:14:08.000Z" };
    expect(checkEconomicCoherence(ticketCrudo).ok).toBe(true);
  });

  test("si el modelo igual lo convierte en ítems de medios de pago: no es una venta", () => {
    expect(parseTicketJson(cierreComoItems)).toEqual(NOT_A_SALE);
  });

  test("también con los medios de pago en $0 y la fila de total incluidas", () => {
    const text = modelJson(
      [
        item("Datafono", 0, 0),
        item("Efectivo", 19, 9400, 178600),
        item("QR", 5, 15220, 76100),
        item("Rappi", 0, 0),
        item("Total (Prop. Incluida)", 1, 254700),
      ],
      254700,
    );
    expect(parseTicketJson(text)).toEqual(NOT_A_SALE);
  });

  test('el modelo responde {"notASale":true}: no es una venta', () => {
    expect(parseTicketJson('{"notASale":true}')).toEqual(NOT_A_SALE);
  });
});

describe("factura real con una línea de pago metida como ítem", () => {
  test("se descarta el 'Efectivo' recibido y la venta queda coherente", () => {
    const text = modelJson([item("Empanada de Carne", 2, 3050), item("Efectivo", 1, 10000)], 6100);

    const ticket = asTicket(parseTicketJson(text));

    expect(ticket.items.map((i) => i.description)).toEqual(["Empanada de Carne"]);
    expect(checkEconomicCoherence(ticket).ok).toBe(true);
  });

  test("se descarta el medio de pago aunque sea igual al total (antes daba el doble)", () => {
    const text = modelJson([item("Horneada de Carne", 1, 5400), item("Pago con QR", 1, 5400)], 5400, 862);

    const ticket = asTicket(parseTicketJson(text));

    expect(ticket.items).toEqual([expect.objectContaining({ description: "Horneada de Carne", subtotal: 5400 })]);
    expect(checkEconomicCoherence(ticket).ok).toBe(true);
  });

  test("'Cambio' (el vuelto) tampoco es un producto", () => {
    const text = modelJson([item("TINTO", 1, 2500), item("Cambio", 1, 7500)], 2500);
    expect(asTicket(parseTicketJson(text)).items.map((i) => i.description)).toEqual(["TINTO"]);
  });
});

test("DIARIO es un producto real de Empanadas Típicas (código C5, $12.000): no se toca", () => {
  const text = modelJson([item("DIARIO", 2, 12000)], 24000, 3832);
  expect(asTicket(parseTicketJson(text)).items).toEqual([expect.objectContaining({ description: "DIARIO", subtotal: 24000 })]);
});

describe("isNonProductLine", () => {
  test.each([
    "Efectivo",
    "EFECTIVO",
    "QR",
    "Datafono",
    "Datáfono",
    "Tarjeta",
    "Tarjeta de Crédito",
    "Nequi",
    "Daviplata",
    "Transferencia",
    "Rappi",
    "Pago en efectivo",
    "Medio de pago: QR",
    "Cambio",
    "Vuelto",
    "Total",
    "Total (Prop. Incluida)",
    "Subtotal",
  ])("'%s' no es un producto", (description) => {
    expect(isNonProductLine(description)).toBe(true);
  });

  test.each([
    "DIARIO",
    "Empanada de Carne",
    "Horneada de Pollo champiñones",
    "CAPUCHINO VAINILLA",
    "Cristal Sin Gas 600 ml",
    "QR Burger",
    "Empanada Efectivo",
    "Tarjeta regalo",
  ])("'%s' es un producto", (description) => {
    expect(isNonProductLine(description)).toBe(false);
  });
});
