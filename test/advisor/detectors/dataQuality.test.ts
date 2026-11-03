import type { HourlyContext } from "../../../src/advisor/detectors/context";
import { detectParseFailures, detectReviewBacklog } from "../../../src/advisor/detectors/dataQuality";

const NOW = new Date("2026-11-04T11:30:00Z");

function context(overrides: Partial<HourlyContext>): HourlyContext {
  return { now: NOW, timeZone: "UTC", agents: [], habits: {}, recentTickets: [], recentWindowHours: 24, reviewQueue: { count: 0 }, ...overrides };
}

const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const tickets = (parsed: number, failed: number) => [
  ...Array.from({ length: parsed }, () => ({ agentId: "a1", capturedAt: hoursAgo(1), status: "parsed" })),
  ...Array.from({ length: failed }, () => ({ agentId: "a1", capturedAt: hoursAgo(1), status: "failed" })),
];

describe("detectReviewBacklog", () => {
  it("cola vacía o chica y reciente: nada", () => {
    expect(detectReviewBacklog(context({ reviewQueue: { count: 0 } }))).toEqual([]);
    expect(detectReviewBacklog(context({ reviewQueue: { count: 3, oldestCapturedAt: hoursAgo(2) } }))).toEqual([]);
  });

  it("muchos pendientes: warn, y muchísimos: critical", () => {
    expect(detectReviewBacklog(context({ reviewQueue: { count: 12, oldestCapturedAt: hoursAgo(2) } }))[0].severity).toBe("warn");
    expect(detectReviewBacklog(context({ reviewQueue: { count: 45, oldestCapturedAt: hoursAgo(2) } }))[0].severity).toBe("critical");
  });

  it("uno solo pero olvidado más de un día: warn; más de tres días: critical", () => {
    expect(detectReviewBacklog(context({ reviewQueue: { count: 1, oldestCapturedAt: hoursAgo(30) } }))[0].severity).toBe("warn");
    expect(detectReviewBacklog(context({ reviewQueue: { count: 1, oldestCapturedAt: hoursAgo(80) } }))[0].severity).toBe("critical");
  });

  it("lleva el conteo y la antigüedad como evidencia", () => {
    const [matter] = detectReviewBacklog(context({ reviewQueue: { count: 12, oldestCapturedAt: hoursAgo(30) } }));
    expect(matter).toMatchObject({ detector: "review_backlog", scope: "total", periodDate: "2026-11-04", actual: 12, evidence: { pendingTickets: 12, oldestAgeHours: 30 } });
  });
});

describe("detectParseFailures", () => {
  it("con pocos tickets no hay estadística suficiente", () => {
    expect(detectParseFailures(context({ recentTickets: tickets(3, 5) }))).toEqual([]);
  });

  it("una tasa de fallos baja es normal", () => {
    expect(detectParseFailures(context({ recentTickets: tickets(95, 5) }))).toEqual([]);
  });

  it("20% de tickets que no se pudieron leer: warn", () => {
    const [matter] = detectParseFailures(context({ recentTickets: tickets(40, 10) }));
    expect(matter).toMatchObject({
      detector: "data_integrity",
      severity: "warn",
      actual: 10,
      evidence: { failedTickets: 10, totalTickets: 50, failureRatePct: 20, windowHours: 24 },
    });
  });

  it("la mitad falla: critical", () => {
    expect(detectParseFailures(context({ recentTickets: tickets(10, 10) }))[0].severity).toBe("critical");
  });
});
