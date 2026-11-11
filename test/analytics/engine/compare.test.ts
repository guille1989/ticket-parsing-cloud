import { averageTicket, chooseBaseline, decompose, median, pctChange, referenceConfidence, selectReferenceDays, windowTotals } from "../../../src/analytics/engine/compare";
import { addDays, currentCutoff, isoWeekday, slotLabel } from "../../../src/analytics/engine/time";
import { formatPct } from "../../../src/analytics/engine/format";
import { CUTOFF_SLOT, LAST_TUESDAY, NOW, TODAY, TZ, row, tuesday } from "./fixtures";

describe("pctChange", () => {
  it("calcula la variación contra la referencia", () => {
    expect(pctChange(1248, 1100)).toBeCloseTo(13.45, 2);
    expect(pctChange(186, 175)).toBeCloseTo(6.29, 2);
  });

  it("con base 0 o ausente devuelve null: nunca infinito ni 100 %", () => {
    expect(pctChange(500, 0)).toBeNull();
    expect(pctChange(500, null)).toBeNull();
    expect(formatPct(null)).toBe("sin base comparable");
  });
});

describe("decompose", () => {
  it("reproduce el ejemplo de referencia: 4.500 vs 5.000 → tickets −200, ticket medio −300", () => {
    const result = decompose({ sales: 4500, tickets: 600 }, { sales: 5000, tickets: 625 });
    expect(result).toEqual({ delta: -500, ticketsEffect: -200, avgTicketEffect: -300 });
  });

  it("los dos efectos suman exactamente la variación total", () => {
    const result = decompose({ sales: 1248, tickets: 186 }, { sales: 1100, tickets: 175 });
    expect(result.ticketsEffect + result.avgTicketEffect).toBeCloseTo(result.delta, 1);
  });

  it("sin tickets en la referencia todo el cambio cae en el ticket medio; sin tickets hoy, en los tickets", () => {
    expect(decompose({ sales: 300, tickets: 3 }, { sales: 0, tickets: 0 })).toEqual({ delta: 300, ticketsEffect: 0, avgTicketEffect: 300 });
    expect(decompose({ sales: 0, tickets: 0 }, { sales: 300, tickets: 3 })).toEqual({ delta: -300, ticketsEffect: -300, avgTicketEffect: 0 });
  });
});

describe("helpers numéricos", () => {
  it("ticket medio 1.248 / 186 = 6,71 y null sin tickets", () => {
    expect(averageTicket(1248, 186)).toBe(6.71);
    expect(averageTicket(0, 0)).toBeNull();
  });

  it("mediana de pares e impares", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("confianza según días de referencia válidos", () => {
    expect([4, 3, 1, 0].map(referenceConfidence)).toEqual(["high", "medium", "low", null]);
  });
});

describe("tiempo", () => {
  it("el corte se baja a la última media hora cerrada, en hora local", () => {
    expect(currentCutoff(NOW, TZ)).toEqual({ day: TODAY, cutoffSlot: CUTOFF_SLOT });
    expect(slotLabel(CUTOFF_SLOT)).toBe("15:30");
  });

  it("usa la fecha local: a las 02:00Z del 11-10 en Bogotá todavía es el 11-09", () => {
    expect(currentCutoff(new Date("2026-11-10T02:00:00Z"), TZ)).toEqual({ day: "2026-11-09", cutoffSlot: 42 });
  });

  it("aritmética de calendario y día de la semana ISO", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays(TODAY, -7)).toBe(LAST_TUESDAY);
    expect(isoWeekday(TODAY)).toBe(2);
    expect(isoWeekday("2026-11-08")).toBe(7);
  });
});

describe("windowTotals / selectReferenceDays", () => {
  const rows = [
    ...tuesday(LAST_TUESDAY, "a1", { sales: 1100, tickets: 175 }),
    ...tuesday("2026-10-27", "a1", { sales: 1000, tickets: 160 }),
    row("2026-10-27", 20, "a2", 50, 5),
  ];

  it("corta en la franja de corte: lo posterior no cuenta, igual hoy que en la referencia", () => {
    expect(windowTotals(rows, LAST_TUESDAY, CUTOFF_SLOT)).toEqual({ sales: 1100, tickets: 175, lastSlot: 20 });
    expect(windowTotals(rows, LAST_TUESDAY, 33).sales).toBe(1500);
  });

  it("filtra por sucursal", () => {
    expect(windowTotals(rows, "2026-10-27", CUTOFF_SLOT, "a2")).toEqual({ sales: 50, tickets: 5, lastSlot: 20 });
  });

  it("un día sin ninguna venta se excluye con su razón en vez de contar como cero", () => {
    const { included, excluded } = selectReferenceDays(rows, TODAY, CUTOFF_SLOT);
    expect(included.map((d) => d.day)).toEqual([LAST_TUESDAY, "2026-10-27"]);
    expect(excluded.length).toBeGreaterThan(0);
    expect(excluded[0]).toEqual({ day: "2026-10-20", reason: expect.stringContaining("sin ventas") });
  });

  it("la referencia es el mismo día de la semana pasada; si estuvo cerrado, la mediana de los otros", () => {
    const withLastWeek = selectReferenceDays(rows, TODAY, CUTOFF_SLOT).included;
    expect(chooseBaseline(TODAY, withLastWeek)).toMatchObject({ basis: "same_weekday_last_week", sales: 1100, tickets: 175 });

    const closedLastWeek = selectReferenceDays(rows.filter((r) => r.day !== LAST_TUESDAY), TODAY, CUTOFF_SLOT).included;
    expect(chooseBaseline(TODAY, closedLastWeek)).toMatchObject({ basis: "median_of_same_weekdays", sales: 1050 });
    expect(chooseBaseline(TODAY, [])).toMatchObject({ basis: "none", sales: null });
  });
});
