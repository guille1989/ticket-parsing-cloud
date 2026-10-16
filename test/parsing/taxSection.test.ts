import { checkEconomicCoherence } from "../../src/parsing/economicCoherence";
import { reconcileWithTaxSection, UNATTRIBUTED_DESCRIPTION } from "../../src/parsing/taxSection";
import type { ParsedTicket } from "../../src/parsing/types";

function item(description: string, quantity: number, unitPrice: number, subtotal = quantity * unitPrice) {
  return { description, quantity, unitPrice, subtotal, voided: false };
}

function ticket(items: ParsedTicket["items"], total: number, tax?: number, taxBase?: number): ParsedTicket {
  return { items, total, tax, taxBase, timestamp: "2026-09-17T22:30:44.000Z" };
}

/** Lo que pasaría después por el handler: si no es coherente, queda `failed`. */
function reconciledAndCoherent(input: ParsedTicket): ParsedTicket {
  const result = reconcileWithTaxSection(input);
  expect(checkEconomicCoherence(result)).toEqual({ ok: true });
  return result;
}

const sinDesglose = (total: number) => [expect.objectContaining({ description: UNATTRIBUTED_DESCRIPTION, quantity: 1, subtotal: total })];

describe("una sola línea de producto (casos reales de Empanadas Típicas)", () => {
  test("total inflado (52c75e41): el modelo le sumó el IVA a un precio que ya lo incluía → total = Base + Impuesto", () => {
    // Impreso: Horneada de Pollo $5.400, Base $4.538, Impuesto $862, VALOR A PAGAR $5.400.
    const result = reconciledAndCoherent(ticket([item("Horneada de Pollo champiñones", 1, 5400)], 6262, 862, 4538));
    expect(result.total).toBe(5400);
    expect(result.items).toEqual([expect.objectContaining({ subtotal: 5400, unitPrice: 5400 })]);
  });

  test("ítem a precio base (23509f4f): columnas cortadas, una sola línea → su total es el VALOR A PAGAR", () => {
    const result = reconciledAndCoherent(ticket([item("Colombiana 400 ml", 1, 4454)], 5300, 846, 4454));
    expect(result.total).toBe(5300);
    expect(result.items).toEqual([expect.objectContaining({ description: "Colombiana 400 ml", quantity: 1, unitPrice: 5300, subtotal: 5300 })]);
  });

  test("ítem a precio base con cantidad > 1: el precio unitario sale de dividir", () => {
    const result = reconciledAndCoherent(ticket([item("Pepsi 400 ml", 2, 4454)], 10600, 1692, 8908));
    expect(result.items).toEqual([expect.objectContaining({ quantity: 2, unitPrice: 5300, subtotal: 10600 })]);
  });

  test("precio en 0 (no visible) con una sola línea: toma el VALOR A PAGAR", () => {
    const result = reconciledAndCoherent(ticket([item("H2Oh! Limonatte 600 ml", 1, 0)], 6100, 974, 5126));
    expect(result.items).toEqual([expect.objectContaining({ unitPrice: 6100, subtotal: 6100 })]);
  });

  test("sin taxBase no se toca: 'precio a base' y 'total inflado' dan la misma cuenta", () => {
    const input = ticket([item("Horneada de Carne", 1, 5400)], 6262, 862);
    expect(reconcileWithTaxSection(input)).toEqual(input);
  });

  test("factura bien leída: no cambia nada", () => {
    const input = ticket([item("DIARIO", 2, 12000)], 24000, 3832, 20168);
    expect(reconciledAndCoherent(input)).toEqual(input);
  });
});

describe("varias líneas sin precio legible → total en una línea 'Sin desglose'", () => {
  test("f76fe443: la Base como precio de un ítem y el Impuesto como precio de otro", () => {
    // Real: Limonatte 6100 + DIARIO 12000. El modelo devolvió Limonat = Base, DIARIO = Impuesto.
    const input = ticket([item("H2Oh! Limonat 600 ml", 1, 15210), item("DIARIO", 1, 2890)], 18100, 2890);
    expect(reconciledAndCoherent(input).items).toEqual(sinDesglose(18100));
  });

  test("d3627668: Base e Impuesto repartidos con cantidad 2", () => {
    const input = ticket([item("ALMOHADA", 2, 8488, 16975), item("CAFE LECHE", 2, 1613, 3225)], 20200, 3225, 16975);
    expect(reconciledAndCoherent(input).items).toEqual(sinDesglose(20200));
  });

  test("6b7de491: un ítem se queda con toda la Base y el otro en 0", () => {
    const input = ticket([item("Hit Mc 300 ml", 1, 9412), item("Horne de Pollo champi", 1, 0)], 11200, 1788);
    expect(reconciledAndCoherent(input).items).toEqual(sinDesglose(11200));
  });

  test("4100b615: la Base repartida entre tres productos con precios inventados", () => {
    const input = ticket(
      [item("Empanada de Carne", 1, 5000), item("Empanada de Pollo", 1, 5000), item("Hit Mo 300 ml", 1, 2605)],
      15000,
      2395,
    );
    expect(reconciledAndCoherent(input).items).toEqual(sinDesglose(15000));
  });

  test("lo que pide el prompt nuevo: precios en 0 para las líneas sin precio visible", () => {
    const input = ticket([item("ALMO.", 2, 0), item("CAFE LECHE", 2, 0)], 20200, 3225, 16975);
    expect(reconciledAndCoherent(input).items).toEqual(sinDesglose(20200));
  });

  test("con el total además inflado: se corrige con Base + Impuesto antes de colapsar", () => {
    const input = ticket([item("TINTO", 1, 2500), item("CAPUCHINO", 1, 4900)], 8581, 1181, 6219);
    // ítems = 7400 = Base + Impuesto: el total 8581 era 7400 + IVA de nuevo; el desglose sí es legible
    const result = reconciledAndCoherent(input);
    expect(result.total).toBe(7400);
    expect(result.items.map((i) => i.description)).toEqual(["TINTO", "CAPUCHINO"]);
  });
});

describe("factura con productos exentos (cc98b8ee): total $14.100, Base + Impuesto = $9.200", () => {
  // Impreso: 1 Cristal Sin Gas (código hash: precios fuera del papel) y 2 Empanadas Rancheras;
  // Impuestos: IVA 19% Base $7.731, Impuesto $1.469; VALOR A PAGAR $14.100.
  test("precios no visibles (en 0): 'Sin desglose' con el total impreso, coherente", () => {
    const input = ticket([item("Cristal Sin Gas 600 ml", 1, 0), item("Empanada Ranchera", 2, 0)], 14100, 1469, 7731);
    const result = reconciledAndCoherent(input);
    expect(result.total).toBe(14100);
    expect(result.items).toEqual(sinDesglose(14100));
  });

  test("lo que había guardado el OCR viejo: total − IVA como precio de un ítem → 'Sin desglose'", () => {
    const input = ticket([item("Criste Gas 60", 1, 12631), item("Empe Ranch", 2, 735)], 14100, 1469, 7731);
    expect(reconciledAndCoherent(input).items).toEqual(sinDesglose(14100));
  });

  test("con los precios legibles no se toca", () => {
    const input = ticket([item("Empanada Ranchera", 2, 4600), item("Cristal Sin Gas 600 ml", 1, 4900)], 14100, 1469, 7731);
    expect(reconciledAndCoherent(input)).toEqual(input);
  });

  test("si el modelo se saltó la línea exenta, NO se baja el total a la parte gravada", () => {
    const input = ticket([item("Empanada Ranchera", 2, 4600)], 14100, 1469, 7731);
    const result = reconcileWithTaxSection(input);
    expect(result.total).toBe(14100);
    // y la coherencia lo rechaza por la suma, como cualquier línea perdida
    expect(checkEconomicCoherence(result).ok).toBe(false);
  });
});

describe("no toca facturas multi-ítem bien leídas", () => {
  test("e8d12dd4-like: Horneada Caprese 2 × 5400 + DIARIO 12000 = 22800", () => {
    const input = ticket([item("Horneada Caprese", 2, 5400), item("DIARIO", 1, 12000)], 22800, 3640, 19160);
    expect(reconciledAndCoherent(input)).toEqual(input);
  });

  test("un producto regalado en $0 cuando el resto ya suma el total", () => {
    const input = ticket([item("Empanada de Carne", 2, 3050), item("Salsa", 1, 0)], 6100, 974, 5126);
    expect(reconciledAndCoherent(input)).toEqual(input);
  });

  test("con descuento o propina no se toca nada", () => {
    const input = { ...ticket([item("ALMOHADA", 2, 8488, 16975), item("CAFE LECHE", 2, 1613, 3225)], 20200, 3225), tip: 0 };
    expect(reconcileWithTaxSection(input)).toEqual(input);
  });

  test("sin sección de impuestos no se toca nada", () => {
    const input = ticket([item("Medialuna", 2, 900)], 1800);
    expect(reconcileWithTaxSection(input)).toEqual(input);
  });
});
