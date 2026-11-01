import { extractProductVolume } from "../../src/assistant/productVolume";

test.each([
  ["AGUA TRATADA 350 ML SIN GAS", "350 ML"],
  ["AGUA TRATADA 600 ML BALA CON GAS", "600 ML"],
  ["AGUA TRATADA 350ML", "350 ML"],
  ["BOTELLON 20 LT", "20 L"],
  ["Agua 1,5 litros", "1.5 L"],
  ["Gaseosa 2.5 L", "2.5 L"],
  ["Arroz 500 gr", "500 G"],
])("%s → %s", (description, expected) => {
  expect(extractProductVolume(description)).toBe(expected);
});

test.each(["CASINO Y RESTAURANTE SERV DE COMEDOR", "Por operación", "AGUA LIGHT", "", undefined])(
  "sin medida (%p) → undefined",
  (description) => {
    expect(extractProductVolume(description)).toBeUndefined();
  },
);
