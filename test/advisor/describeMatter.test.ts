import { describeMatter, duration } from "../../src/advisor/describeMatter";
import type { MatterItem } from "../../src/advisor/types";

type M = Parameters<typeof describeMatter>[0];

const matter = (overrides: Partial<M> & Pick<M, "detector">): M => ({
  scope: "total",
  periodDate: "2026-11-03", // martes
  evidence: {},
  ...overrides,
});

describe("duration", () => {
  it("minutos, horas y días, aproximados", () => {
    expect(duration(1)).toBe("1 minuto");
    expect(duration(45)).toBe("45 minutos");
    expect(duration(89)).toBe("89 minutos");
    expect(duration(90)).toBe("2 horas");
    expect(duration(180)).toBe("3 horas");
    expect(duration(60 * 50)).toBe("2 días");
  });
});

describe("describeMatter", () => {
  it("robot caído: nombra la sucursal y la duración", () => {
    const text = describeMatter(
      matter({ detector: "agent_offline", scope: "branch:a1", evidence: { agentName: "Robot 1", minutesSinceSeen: 195 } }),
      "TPV Sol",
    );
    expect(text.title).toBe("TPV Sol lleva 3 horas sin conectarse");
    expect(text.detail).toContain("Revisa que el equipo esté encendido");
    expect(text.spoken).toBe(`${text.title}. ${text.detail}`);
  });

  it("robot caído sin etiqueta de sucursal usa el nombre del robot, y sin minutos dice que nunca reportó", () => {
    const text = describeMatter(matter({ detector: "agent_offline", scope: "branch:a1", evidence: { agentName: "Caja 2", minutesSinceSeen: null } }), null);
    expect(text.title).toBe("Caja 2 no ha reportado señal");
  });

  it("captura en cero: dice cuántos tickets se esperaban", () => {
    const text = describeMatter(matter({ detector: "capture_zero", scope: "branch:a1", expected: 45.2, actual: 0, evidence: { windowHours: 3 } }), "Chamberí");
    expect(text.title).toBe("Chamberí está conectada pero no captura ventas");
    expect(text.detail).toBe("En las últimas 3 horas se esperaban unos 45 tickets y no entró ninguno. Puede ser la impresora o el POS.");
  });

  it("cola de revisión: singular, plural y antigüedad", () => {
    expect(describeMatter(matter({ detector: "review_backlog", actual: 1, evidence: { oldestAgeHours: 2 } }), null).title).toBe("1 ticket espera tu revisión");
    const many = describeMatter(matter({ detector: "review_backlog", actual: 12, evidence: { oldestAgeHours: 80 } }), null);
    expect(many.title).toBe("12 tickets esperan tu revisión");
    expect(many.detail).toContain("El más antiguo lleva 3 días sin revisar.");
    expect(describeMatter(matter({ detector: "review_backlog", actual: 12, evidence: { oldestAgeHours: 5 } }), null).detail).not.toContain("más antiguo");
  });

  it("tickets que no se pudieron leer", () => {
    const text = describeMatter(matter({ detector: "data_integrity", actual: 10, evidence: { failureRatePct: 20, failedTickets: 10, totalTickets: 50, windowHours: 24 } }), null);
    expect(text.title).toBe("20 % de los tickets recientes no se pudo leer");
    expect(text.detail).toContain("10 de 50 tickets de las últimas 24 horas");
  });

  describe("venta anómala", () => {
    it("caída de una sucursal, con el día de la semana y montos con punto de miles", () => {
      const text = describeMatter(
        matter({ detector: "sales_anomaly", scope: "branch:a1", periodDate: "2026-11-02", expected: 1700, actual: 1070, evidence: { direction: "drop", deltaPct: -37.1 } }),
        "Chamberí",
      );
      expect(text.title).toBe("Chamberí vendió un 37 % menos de lo habitual el lunes");
      expect(text.detail).toBe("Vendió 1.070 frente a unos 1.700 de un lunes normal.");
    });

    it("pico del negocio completo", () => {
      const text = describeMatter(matter({ detector: "sales_anomaly", expected: 4126.01, actual: 6000, evidence: { direction: "spike", deltaPct: 45.4 } }), null);
      expect(text.title).toBe("El negocio vendió un 45 % más de lo habitual el martes");
      expect(text.detail).toBe("Vendió 6.000 frente a unos 4.126 de un martes normal.");
    });

    it("un día sin ninguna venta se dice tal cual, sin porcentaje", () => {
      const text = describeMatter(matter({ detector: "sales_anomaly", expected: 4804.82, actual: 0, evidence: { direction: "drop", deltaPct: -100 } }), null);
      expect(text.title).toBe("El negocio no registró ventas el martes");
      expect(text.detail).toBe("Un martes normal vende unos 4.805.");
    });
  });

  it("jamás deja escapar undefined, NaN o null, ni con evidencia vacía", () => {
    for (const detector of ["sales_anomaly", "agent_offline", "capture_zero", "review_backlog", "data_integrity"] as MatterItem["detector"][]) {
      const { title, detail, spoken } = describeMatter(matter({ detector }), null);
      for (const value of [title, detail, spoken]) expect(value).not.toMatch(/undefined|NaN|null/);
      expect(title.length).toBeGreaterThan(0);
    }
  });
});
