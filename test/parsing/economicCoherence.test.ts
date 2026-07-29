import { checkEconomicCoherence } from "../../src/parsing/economicCoherence";
import type { ParsedTicket } from "../../src/parsing/types";

function ticket(overrides: Partial<ParsedTicket> = {}): ParsedTicket {
  return {
    items: [{ description: "Café", quantity: 2, unitPrice: 900, subtotal: 1800, voided: false }],
    total: 1800,
    timestamp: "2026-07-29T20:00:00.000Z",
    ...overrides,
  };
}

test("ticket coherente: total = suma de subtotales, subtotal = cantidad × precio", () => {
  expect(checkEconomicCoherence(ticket())).toEqual({ ok: true });
});

test("total negativo: no coherente", () => {
  const result = checkEconomicCoherence(ticket({ total: -100 }));
  expect(result.ok).toBe(false);
});

test("cantidad cero o negativa en un ítem: no coherente", () => {
  const result = checkEconomicCoherence(
    ticket({ items: [{ description: "X", quantity: 0, unitPrice: 100, subtotal: 0, voided: false }] }),
  );
  expect(result.ok).toBe(false);
});

test("ticket sin ítems: no coherente", () => {
  const result = checkEconomicCoherence(ticket({ items: [], total: 0 }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/no tiene ítems/);
});

test("subtotal que no coincide con cantidad × precio unitario: no coherente", () => {
  const result = checkEconomicCoherence(
    ticket({ items: [{ description: "X", quantity: 2, unitPrice: 900, subtotal: 5000, voided: false }] }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/subtotal/);
});

test("total que no coincide con la suma de ítems: no coherente", () => {
  const result = checkEconomicCoherence(ticket({ total: 5000 }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/total/);
});

test("descripción vacía: no coherente", () => {
  const result = checkEconomicCoherence(
    ticket({ items: [{ description: "   ", quantity: 1, unitPrice: 900, subtotal: 900, voided: false }] }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/descripción vacía/);
});

test("cantidad, precio o subtotal no finito (ej. desbordó a Infinity): no coherente", () => {
  const result = checkEconomicCoherence(
    ticket({ items: [{ description: "X", quantity: 1, unitPrice: 1e400, subtotal: 1e400, voided: false }] }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/no finitos/);
});

test("total no finito: no coherente", () => {
  const result = checkEconomicCoherence(ticket({ total: Infinity }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/finito/);
});

test("más ítems que el techo razonable: no coherente", () => {
  const manyItems = Array.from({ length: 51 }, (_, i) => ({
    description: `Item ${i}`,
    quantity: 1,
    unitPrice: 100,
    subtotal: 100,
    voided: false,
  }));
  const result = checkEconomicCoherence(ticket({ items: manyItems, total: 5100 }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/demasiados ítems/);
});

test("acepta exactamente el máximo de 50 ítems", () => {
  const items = Array.from({ length: 50 }, (_, i) => ({
    description: `Item ${i}`,
    quantity: 1,
    unitPrice: 100,
    subtotal: 100,
    voided: false,
  }));
  expect(checkEconomicCoherence(ticket({ items, total: 5000 }))).toEqual({ ok: true });
});

test("total por encima del techo razonable: no coherente", () => {
  const result = checkEconomicCoherence(
    ticket({
      items: [{ description: "Algo caro", quantity: 1, unitPrice: 600_000, subtotal: 600_000, voided: false }],
      total: 600_000,
    }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/techo razonable/);
});

test("precio unitario por encima del techo razonable: no coherente", () => {
  const result = checkEconomicCoherence(
    ticket({
      items: [{ description: "Algo caro", quantity: 0.5, unitPrice: 500_001, subtotal: 250_000.5, voided: false }],
      total: 250_000.5,
    }),
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/precio unitario/);
});

test("acepta un importe exactamente en el techo razonable", () => {
  expect(
    checkEconomicCoherence(
      ticket({
        items: [{ description: "Producto", quantity: 1, unitPrice: 500_000, subtotal: 500_000, voided: false }],
        total: 500_000,
      }),
    ),
  ).toEqual({ ok: true });
});

test("descuento y propina se restan/suman correctamente al total esperado", () => {
  const result = checkEconomicCoherence(
    ticket({
      items: [{ description: "Café", quantity: 2, unitPrice: 900, subtotal: 1800, voided: false }],
      discount: 300,
      tip: 200,
      total: 1700, // 1800 - 300 + 200
    }),
  );
  expect(result.ok).toBe(true);
});

test.each([-1, Infinity, -Infinity, NaN])("descuento inválido (%s): no coherente", (discount) => {
  const result = checkEconomicCoherence(ticket({ discount }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/descuento inválido/);
});

test("descuento superior a la suma de artículos: no coherente", () => {
  const result = checkEconomicCoherence(ticket({ discount: 2000, total: 0 }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/descuento/);
});

test("acepta descuento cero", () => {
  expect(checkEconomicCoherence(ticket({ discount: 0 }))).toEqual({ ok: true });
});

test.each([-1, Infinity, -Infinity, NaN])("propina inválida (%s): no coherente", (tip) => {
  const result = checkEconomicCoherence(ticket({ tip }));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toMatch(/propina inválida/);
});

test("propina por encima del techo razonable: no coherente", () => {
  const result = checkEconomicCoherence(ticket({ tip: 500_001, total: 501_801 }));
  expect(result.ok).toBe(false);
});

test("acepta propina cero", () => {
  expect(checkEconomicCoherence(ticket({ tip: 0 }))).toEqual({ ok: true });
});

test("ítem *ANULADO* (voided) no suma al total esperado — igual que fixtures/sample-tickets/05-item-anulado.txt", () => {
  const result = checkEconomicCoherence({
    items: [
      { description: "Combo Milanesa", quantity: 1, unitPrice: 3450, subtotal: 3450, voided: false },
      { description: "Hamburguesa Compl.", quantity: 1, unitPrice: 4200, subtotal: 4200, voided: true },
      { description: "Café con Leche", quantity: 2, unitPrice: 900, subtotal: 1800, voided: false },
    ],
    total: 5250, // 3450 + 1800, sin el ítem anulado
    timestamp: "2026-07-19T20:03:00.000Z",
  });
  expect(result.ok).toBe(true);
});

test("tolera un centavo de diferencia por redondeo", () => {
  const result = checkEconomicCoherence(ticket({ total: 1799 }));
  expect(result.ok).toBe(true);
});

test("rechaza una diferencia superior a la tolerancia absoluta", () => {
  const result = checkEconomicCoherence(ticket({ total: 1798 }));
  expect(result.ok).toBe(false);
});

test("un importe alto no permite miles de pesos de diferencia", () => {
  const result = checkEconomicCoherence(
    ticket({
      items: [{ description: "Producto caro", quantity: 1, unitPrice: 500_000, subtotal: 500_000, voided: false }],
      total: 495_001,
    }),
  );
  expect(result.ok).toBe(false);
});

test("un subtotal alto no permite una diferencia relativa grande", () => {
  const result = checkEconomicCoherence(
    ticket({
      items: [{ description: "Producto caro", quantity: 1, unitPrice: 500_000, subtotal: 495_001, voided: false }],
      total: 495_001,
    }),
  );
  expect(result.ok).toBe(false);
});

test("un ítem anulado sigue necesitando valores internos coherentes", () => {
  const result = checkEconomicCoherence(
    ticket({
      items: [
        { description: "Anulado", quantity: 2, unitPrice: 100, subtotal: 999, voided: true },
        { description: "Válido", quantity: 1, unitPrice: 1800, subtotal: 1800, voided: false },
      ],
      total: 1800,
    }),
  );
  expect(result.ok).toBe(false);
});

test("todos los ítems anulados permiten total cero", () => {
  const result = checkEconomicCoherence(
    ticket({
      items: [{ description: "Anulado", quantity: 1, unitPrice: 100, subtotal: 100, voided: true }],
      total: 0,
    }),
  );
  expect(result.ok).toBe(true);
});
