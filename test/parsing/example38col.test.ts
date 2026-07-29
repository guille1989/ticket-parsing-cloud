import { readFileSync } from "node:fs";
import { join } from "node:path";

import { example38ColParser } from "../../src/parsing/parsers/example38col";

function fixture(name: string): string {
  return readFileSync(join(process.cwd(), "fixtures", "sample-tickets", name), "utf-8");
}

// El README del proyecto afirma "el parser sigue dando 5/5 contra las
// fixtures sintéticas" — hasta ahora eso no estaba respaldado por ningún
// test corrible, era una afirmación manual. Estos 5 casos son los mismos
// que documenta fixtures/sample-tickets/README.md.

test("01-item-unico: un solo producto", () => {
  const result = example38ColParser.parse(fixture("01-item-unico.txt"));
  expect(result).not.toBeNull();
  expect(result?.items).toEqual([
    { quantity: 1, description: "Combo Milanesa", unitPrice: 3450, subtotal: 3450, voided: false },
  ]);
  expect(result?.total).toBe(3450);
  expect(result?.discount).toBeUndefined();
  expect(result?.tip).toBeUndefined();
});

test("02-multiples-items: varios productos distintos", () => {
  const result = example38ColParser.parse(fixture("02-multiples-items.txt"));
  expect(result).not.toBeNull();
  expect(result?.items).toEqual([
    { quantity: 2, description: "Empanadas x6", unitPrice: 2200, subtotal: 4400, voided: false },
    { quantity: 1, description: "Pizza Muzzarella", unitPrice: 5200, subtotal: 5200, voided: false },
    { quantity: 3, description: "Café con Leche", unitPrice: 900, subtotal: 2700, voided: false },
  ]);
  expect(result?.total).toBe(12300);
});

test("03-con-descuento: el total ya refleja el descuento aplicado", () => {
  const result = example38ColParser.parse(fixture("03-con-descuento.txt"));
  expect(result).not.toBeNull();
  expect(result?.total).toBe(7335);
  expect(result?.discount).toBe(815);
});

test("04-con-propina: propina se extrae aparte del total", () => {
  const result = example38ColParser.parse(fixture("04-con-propina.txt"));
  expect(result).not.toBeNull();
  expect(result?.total).toBe(21120);
  expect(result?.tip).toBe(1920);
});

test("05-item-anulado: el ítem anulado se marca voided y no infla el total", () => {
  const result = example38ColParser.parse(fixture("05-item-anulado.txt"));
  expect(result).not.toBeNull();
  expect(result?.items).toEqual([
    { quantity: 1, description: "Combo Milanesa", unitPrice: 3450, subtotal: 3450, voided: false },
    { quantity: 1, description: "Hamburguesa Compl.", unitPrice: 4200, subtotal: 4200, voided: true },
    { quantity: 2, description: "Café con Leche", unitPrice: 900, subtotal: 1800, voided: false },
  ]);
  // El total sale de la línea TOTAL: impresa, no de sumar items — así que
  // ya viene sin el anulado incluido, tal como lo mandaría el POS real.
  expect(result?.total).toBe(5250);
});

test("texto que no matchea el formato devuelve null, no explota", () => {
  const result = example38ColParser.parse("esto no es un ticket, es cualquier cosa\nsin TOTAL ni items");
  expect(result).toBeNull();
});

test("texto vacío devuelve null", () => {
  expect(example38ColParser.parse("")).toBeNull();
});
