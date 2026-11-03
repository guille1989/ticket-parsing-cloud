import { localDate, localHour } from "../../src/travis/localTime";

const instant = new Date("2026-11-04T03:00:00Z");

test("la fecha local puede ser el día anterior al de UTC", () => {
  expect(localDate(instant, "America/Bogota")).toBe("2026-11-03");
  expect(localDate(instant, "Europe/Madrid")).toBe("2026-11-04");
  expect(localDate(instant, "UTC")).toBe("2026-11-04");
});

test("la hora local respeta la zona (Bogotá UTC-5, Madrid UTC+1 en noviembre)", () => {
  expect(localHour(instant, "America/Bogota")).toBe(22);
  expect(localHour(instant, "Europe/Madrid")).toBe(4);
});

test("medianoche local es la hora 0, no 24", () => {
  expect(localHour(new Date("2026-11-04T05:00:00Z"), "America/Bogota")).toBe(0);
});
