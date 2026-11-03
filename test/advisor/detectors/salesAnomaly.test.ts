import { DEFAULT_SALES_THRESHOLDS, detectSalesAnomalies } from "../../../src/advisor/detectors/salesAnomaly";
import { buildHistory, NOW } from "./fixtures";

const TARGET = "2026-11-03";
const detect = (history: ReturnType<typeof buildHistory>, now: Date = NOW, timeZone = "UTC") => detectSalesAnomalies({ now, timeZone, history });
const dropOnTarget = (multiplier: number) => (day: string) => (day === TARGET ? multiplier : 1);

test("los umbrales se pueden sobreescribir: con un piso de dispersión del 25% una caída del 32% ya es variación normal", () => {
  const history = buildHistory({ factor: dropOnTarget(0.68) });

  expect(detectSalesAnomalies({ now: NOW, timeZone: "UTC", history })).not.toHaveLength(0);
  expect(detectSalesAnomalies({ now: NOW, timeZone: "UTC", history }, { ...DEFAULT_SALES_THRESHOLDS, scaleFloor: 0.25 })).toEqual([]);
});

test("un negocio estable no genera asuntos", () => {
  expect(detect(buildHistory())).toEqual([]);
});

test("una caída fuerte de ayer es critical y lleva los números que la respaldan", () => {
  const [matter] = detect(buildHistory({ factor: dropOnTarget(0.5) }));

  expect(matter).toMatchObject({
    detector: "sales_anomaly",
    scope: "total",
    periodDate: TARGET,
    severity: "critical",
    expected: 400,
    actual: 200,
    evidence: { direction: "drop", deltaPct: -50, baselineDays: 6, expectedTickets: 20 },
  });
  expect(matter.evidence.z).toBeLessThan(-3);
});

test("una caída moderada es warn, y una leve (25%) se considera variación normal", () => {
  // Con un solo robot, el total y la sucursal son lo mismo: salen los dos asuntos.
  const moderate = detect(buildHistory({ factor: dropOnTarget(0.68) }));
  expect(moderate.map((m) => `${m.scope}:${m.severity}`).sort()).toEqual(["branch:a1:warn", "total:warn"]);
  expect(detect(buildHistory({ factor: dropOnTarget(0.75) }))).toEqual([]);
});

test("un pico es una buena noticia: avisa, pero nunca como critical", () => {
  const [matter] = detect(buildHistory({ factor: dropOnTarget(2) }));
  expect(matter).toMatchObject({ severity: "warn", evidence: { direction: "spike", deltaPct: 100 } });

  const [mild] = detect(buildHistory({ factor: dropOnTarget(1.35) }));
  expect(mild.severity).toBe("info");
});

test("compara contra el mismo día de la semana: un martes flojo no se mide contra el promedio de la semana", () => {
  // Los martes se vende la mitad que el resto de días. Ayer (martes) vendió la mitad: es lo normal.
  const history = buildHistory({ factor: (day) => (new Date(`${day}T00:00:00Z`).getUTCDay() === 2 ? 0.5 : 1) });
  expect(detect(history)).toEqual([]);
});

test("detecta la sucursal que cae aunque el total del negocio apenas se mueva", () => {
  const history = buildHistory({ agentIds: ["a1", "a2", "a3"], factor: (day, agentId) => (day === TARGET && agentId === "a2" ? 0 : 1) });

  const matters = detect(history);

  const branch = matters.find((m) => m.scope === "branch:a2");
  expect(branch).toMatchObject({ severity: "critical", actual: 0, expected: 400, evidence: { agentId: "a2" } });
  // 3 sucursales: el total cae 33%, apenas warn; las otras dos sucursales no alertan.
  expect(matters.find((m) => m.scope === "total")?.severity).toBe("warn");
  expect(matters.map((m) => m.scope).sort()).toEqual(["branch:a2", "total"]);
});

test("un ayer sin ninguna venta, en un negocio que sí vende ese día, es una caída critical", () => {
  const [matter] = detect(buildHistory({ factor: dropOnTarget(0) }));
  expect(matter).toMatchObject({ scope: "total", severity: "critical", actual: 0 });
});

test("sin historial suficiente (3 semanas) no opina", () => {
  expect(detect(buildHistory({ days: 21, factor: dropOnTarget(0) }))).toEqual([]);
});

test("una sucursal nueva no se compara contra semanas en que todavía no existía", () => {
  // a2 empezó hace 10 días: solo hay 1 mismo-día-de-semana anterior, no alcanza para opinar de ella.
  const history = [
    ...buildHistory({ agentIds: ["a1"] }),
    ...buildHistory({ agentIds: ["a2"], days: 10, factor: dropOnTarget(0.2) }),
  ];
  expect(detect(history).filter((m) => m.scope === "branch:a2")).toEqual([]);
});

test("con poca actividad (2 tickets al día) cualquier variación es ruido", () => {
  expect(detect(buildHistory({ hours: [10], ticketsPerHour: 2, factor: dropOnTarget(0) }))).toEqual([]);
});

test("un día en que el negocio normalmente cierra no cuenta como caída", () => {
  // Los martes no vende nadie (baseline 0); ayer, martes, tampoco.
  const history = buildHistory({ factor: (day) => (new Date(`${day}T00:00:00Z`).getUTCDay() === 2 ? 0 : 1) });
  expect(detect(history)).toEqual([]);
});

test('"ayer" es el día local: a las 03:00 UTC en Bogotá todavía es el 3, así que se evalúa el 2', () => {
  const history = buildHistory({ lastDay: "2026-11-02", factor: (day) => (day === "2026-11-02" ? 0.5 : 1) });

  const [matter] = detect(history, new Date("2026-11-04T03:00:00Z"), "America/Bogota");

  expect(matter.periodDate).toBe("2026-11-02");
});
