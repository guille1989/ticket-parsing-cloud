import { ACTIVATION_CODE_PATTERN, generateActivationCode } from "../../src/shared/activationCode";

test("genera códigos con el formato XXXXX-XXXXX", () => {
  const code = generateActivationCode();
  expect(code).toMatch(ACTIVATION_CODE_PATTERN);
  expect(code).toHaveLength(11);
});

test("no genera caracteres ambiguos (0/O, 1/I/L)", () => {
  for (let i = 0; i < 200; i++) {
    expect(generateActivationCode()).not.toMatch(/[01ILO]/);
  }
});

test("dos códigos generados no son iguales (sanity de aleatoriedad)", () => {
  const codes = new Set(Array.from({ length: 50 }, () => generateActivationCode()));
  expect(codes.size).toBe(50);
});
