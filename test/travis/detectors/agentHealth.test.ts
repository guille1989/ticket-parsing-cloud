import { detectAgentOffline, detectCaptureZero } from "../../../src/travis/detectors/agentHealth";
import type { HourlyContext } from "../../../src/travis/detectors/context";
import type { AgentRecord } from "../../../src/shared/types";
import { habitFor } from "./fixtures";

const NOW = new Date("2026-11-04T11:30:00Z"); // 11:30 en UTC
const MINUTE = 60_000;

function agent(agentId: string, minutesAgo: number | null): AgentRecord {
  return {
    tenantId: "t1",
    agentId,
    name: `Caja ${agentId}`,
    apiKeyId: "k",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...(minutesAgo === null ? {} : { lastSeenAt: new Date(NOW.getTime() - minutesAgo * MINUTE).toISOString() }),
  };
}

function context(overrides: Partial<HourlyContext>): HourlyContext {
  return {
    now: NOW,
    timeZone: "UTC",
    agents: [],
    habits: { a1: habitFor([8, 9, 10, 11, 12, 13]) },
    recentTickets: [],
    recentWindowHours: 6,
    reviewQueue: { count: 0 },
    ...overrides,
  };
}

const ticketAt = (iso: string, agentId = "a1") => ({ agentId, capturedAt: iso, status: "parsed" });

describe("detectAgentOffline", () => {
  it("robot sin señal hace 45 min en su horario de trabajo: warn", () => {
    const [matter] = detectAgentOffline(context({ agents: [agent("a1", 45)] }));
    expect(matter).toMatchObject({
      detector: "agent_offline",
      scope: "branch:a1",
      periodDate: "2026-11-04",
      severity: "warn",
      evidence: { agentId: "a1", agentName: "Caja a1", minutesSinceSeen: 45, localHour: 11 },
    });
  });

  it("más de 3 horas sin señal: critical", () => {
    expect(detectAgentOffline(context({ agents: [agent("a1", 240)] }))[0].severity).toBe("critical");
  });

  it("robot con heartbeat reciente: nada", () => {
    expect(detectAgentOffline(context({ agents: [agent("a1", 5)] }))).toEqual([]);
  });

  it("fuera de su horario de trabajo una PC apagada es lo normal", () => {
    expect(detectAgentOffline(context({ now: new Date("2026-11-04T03:00:00Z"), agents: [agent("a1", 600)] }))).toEqual([]);
  });

  it("robot sin hábito (poco historial) no se vigila", () => {
    expect(detectAgentOffline(context({ habits: {}, agents: [agent("a1", 600)] }))).toEqual([]);
  });

  it("robot que nunca reportó pero tiene hábito: critical, sin minutos", () => {
    const [matter] = detectAgentOffline(context({ agents: [agent("a1", null)] }));
    expect(matter).toMatchObject({ severity: "critical", evidence: { minutesSinceSeen: null, lastSeenAt: null } });
  });
});

describe("detectCaptureZero", () => {
  it("robot vivo, sin un solo ticket en 3 horas en que suele capturar 15: critical", () => {
    const [matter] = detectCaptureZero(context({ agents: [agent("a1", 2)] }));
    expect(matter).toMatchObject({
      detector: "capture_zero",
      scope: "branch:a1",
      severity: "critical",
      expected: 15,
      actual: 0,
      evidence: { agentId: "a1", windowHours: 3 },
    });
  });

  it("con pocos tickets esperados es warn", () => {
    const habits = { a1: habitFor([10], 4) };
    expect(detectCaptureZero(context({ habits, agents: [agent("a1", 2)] }))[0].severity).toBe("warn");
  });

  it("un solo ticket en la ventana (08:00-11:00) descarta la alerta", () => {
    const recentTickets = [ticketAt("2026-11-04T09:30:00.000Z")];
    expect(detectCaptureZero(context({ agents: [agent("a1", 2)], recentTickets }))).toEqual([]);
  });

  it("un ticket de la hora en curso (después de las 11:00) no cuenta como captura de la ventana", () => {
    const recentTickets = [ticketAt("2026-11-04T11:10:00.000Z")];
    expect(detectCaptureZero(context({ agents: [agent("a1", 2)], recentTickets }))).toHaveLength(1);
  });

  it("los tickets de otro robot no cuentan", () => {
    const recentTickets = [ticketAt("2026-11-04T09:30:00.000Z", "a2")];
    expect(detectCaptureZero(context({ agents: [agent("a1", 2)], recentTickets }))).toHaveLength(1);
  });

  it("robot caído no es captura en cero: eso lo cubre agent_offline", () => {
    expect(detectCaptureZero(context({ agents: [agent("a1", 90)] }))).toEqual([]);
  });

  it("si en esa franja casi nunca captura (menos de 3 esperados), no alerta", () => {
    const habits = { a1: habitFor([10], 1) };
    expect(detectCaptureZero(context({ habits, agents: [agent("a1", 2)] }))).toEqual([]);
  });

  it("mide la ventana en hora local, también con desfase de media hora", () => {
    // 17:00 UTC = 22:30 en Katmandú (UTC+5:45 -> 22:45). Ventana local: 19:00-22:00; hábito en esas horas.
    const now = new Date("2026-11-04T17:00:00Z");
    const habits = { a1: habitFor([19, 20, 21, 22], 5) };
    const agents = [{ ...agent("a1", 0), lastSeenAt: now.toISOString() }];
    const [matter] = detectCaptureZero(context({ now, timeZone: "Asia/Kathmandu", habits, agents }));
    expect(matter.expected).toBe(15);
  });
});
