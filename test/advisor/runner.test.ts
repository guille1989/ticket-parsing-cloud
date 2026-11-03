import { matterKey } from "../../src/shared/dynamo";
import type { AgentRecord } from "../../src/shared/types";
import { resolveSettings, runTenant, type AdvisorDeps } from "../../src/advisor/runner";
import type { AdvisorTenant } from "../../src/advisor/opsData";
import type { MatterItem } from "../../src/advisor/types";
import { buildHistory, habitFor } from "./detectors/fixtures";

const tenant: AdvisorTenant = { tenantId: "t1", businessName: "Alamo", advisor: { timeZone: "UTC", briefingHour: 7 } };
const BEFORE_BRIEFING = new Date("2026-11-04T05:00:00Z");
const AFTER_BRIEFING = new Date("2026-11-04T08:00:00Z");
const TODAY = "2026-11-04";

// Ayer (martes 3) se vendió la mitad de lo habitual: el análisis diario debe detectarlo.
const history = buildHistory({ factor: (day) => (day === "2026-11-03" ? 0.5 : 1) });

function agent(lastSeenMinutesAgo: number, now: Date): AgentRecord {
  return {
    tenantId: "t1",
    agentId: "a1",
    name: "Caja 1",
    apiKeyId: "k",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: new Date(now.getTime() - lastSeenMinutesAgo * 60_000).toISOString(),
  };
}

function makeDeps(overrides: Partial<AdvisorDeps> = {}) {
  const deps = {
    loadSalesHistory: jest.fn(async () => history),
    loadAgents: jest.fn(async () => [agent(1, AFTER_BRIEFING)]),
    loadRecentTickets: jest.fn(async () => []),
    loadReviewQueue: jest.fn(async () => ({ count: 0 })),
    loadHabitProfile: jest.fn(async () => undefined),
    saveHabitProfile: jest.fn(async () => undefined),
    upsertMatters: jest.fn(async (tenantId: string, candidates) =>
      candidates.map((c: any) => ({
        change: "created" as const,
        item: { ...matterKey(tenantId, c.periodDate, c.detector, c.scope), ...c } as unknown as MatterItem,
      })),
    ),
    resolveClearedMatters: jest.fn(async () => 0),
    ...overrides,
  };
  return deps as unknown as MockDeps;
}

type MockDeps = { [K in keyof AdvisorDeps]: jest.MockedFunction<AdvisorDeps[K]> };

const storedProfile = (dailyDate: string) => ({ habits: { a1: habitFor([8, 9, 10, 11, 12, 13]) }, computedAt: "x", dailyDate });

describe("runTenant", () => {
  it("antes de la hora del briefing y sin perfil: solo chequeos horarios, sin tocar Athena", async () => {
    const deps = makeDeps();

    const result = await runTenant(tenant, BEFORE_BRIEFING, {}, deps);

    expect(deps.loadSalesHistory).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ranDaily: false, ranHourly: true, errors: [] });
    expect(deps.saveHabitProfile).not.toHaveBeenCalled();
    // Sin hábitos, robot caído y captura en cero no pudieron evaluar: no se pueden dar por resueltos.
    expect(deps.resolveClearedMatters.mock.calls[0][2]).toEqual(["review_backlog", "data_integrity"]);
  });

  it("primera pasada desde la hora del briefing: análisis diario, asuntos y perfil guardado", async () => {
    const deps = makeDeps();

    const result = await runTenant(tenant, AFTER_BRIEFING, {}, deps);

    expect(result).toMatchObject({ ranDaily: true, ranHourly: true, created: 2, errors: [] });
    expect(result.candidates.map((c) => `${c.detector}:${c.scope}`).sort()).toEqual(["sales_anomaly:branch:a1", "sales_anomaly:total"]);
    expect(deps.upsertMatters).toHaveBeenCalledTimes(1);
    const [, profile] = deps.saveHabitProfile.mock.calls[0];
    expect(profile.dailyDate).toBe(TODAY);
    expect(profile.habits).toHaveProperty("a1");
    expect(deps.resolveClearedMatters.mock.calls[0][2]).toEqual(["review_backlog", "data_integrity", "agent_offline", "capture_zero"]);
  });

  it("segunda pasada del mismo día: no repite Athena y usa los hábitos guardados", async () => {
    const deps = makeDeps({ loadHabitProfile: jest.fn(async () => storedProfile(TODAY)) });

    const result = await runTenant(tenant, new Date("2026-11-04T09:00:00Z"), {}, deps);

    expect(deps.loadSalesHistory).not.toHaveBeenCalled();
    expect(result.ranDaily).toBe(false);
    expect(deps.resolveClearedMatters.mock.calls[0][2]).toContain("agent_offline");
  });

  it("al día siguiente vuelve a hacer el análisis diario", async () => {
    const deps = makeDeps({ loadHabitProfile: jest.fn(async () => storedProfile("2026-11-03")) });

    await runTenant(tenant, AFTER_BRIEFING, {}, deps);

    expect(deps.loadSalesHistory).toHaveBeenCalledTimes(1);
  });

  it("forceDaily lo corre aunque sea antes de la hora", async () => {
    const deps = makeDeps();

    const result = await runTenant(tenant, BEFORE_BRIEFING, { forceDaily: true }, deps);

    expect(result.ranDaily).toBe(true);
  });

  it("con hábitos guardados, un robot silencioso en su horario de trabajo se detecta en la pasada horaria", async () => {
    const now = new Date("2026-11-04T11:30:00Z");
    const deps = makeDeps({
      loadHabitProfile: jest.fn(async () => storedProfile(TODAY)),
      loadAgents: jest.fn(async () => [agent(200, now)]),
    });

    const result = await runTenant(tenant, now, {}, deps);

    expect(result.candidates).toEqual([expect.objectContaining({ detector: "agent_offline", severity: "critical" })]);
  });

  it("si Athena falla, registra el error, igual hace los chequeos horarios y no da el día por hecho", async () => {
    const deps = makeDeps({ loadSalesHistory: jest.fn(async () => { throw new Error("timeout de Athena"); }) });

    const result = await runTenant(tenant, AFTER_BRIEFING, {}, deps);

    expect(result.errors).toEqual(["análisis diario: timeout de Athena"]);
    expect(result).toMatchObject({ ranDaily: false, ranHourly: true });
    expect(deps.saveHabitProfile).not.toHaveBeenCalled(); // la hora siguiente reintenta
  });

  it("si fallan los chequeos horarios no resuelve nada, pero sí guarda lo del análisis diario", async () => {
    const deps = makeDeps({ loadAgents: jest.fn(async () => { throw new Error("dynamo caído"); }) });

    const result = await runTenant(tenant, AFTER_BRIEFING, {}, deps);

    expect(result.errors).toEqual(["chequeos horarios: dynamo caído"]);
    expect(result.ranHourly).toBe(false);
    expect(deps.resolveClearedMatters).not.toHaveBeenCalled();
    expect(result.created).toBe(2);
  });

  it("dry-run: calcula y devuelve lo detectado, no escribe asuntos, pero sí el perfil (para no repetir Athena cada hora)", async () => {
    const deps = makeDeps();

    const result = await runTenant(tenant, AFTER_BRIEFING, { dryRun: true }, deps);

    expect(result.candidates).toHaveLength(2);
    expect(result).toMatchObject({ dryRun: true, created: 0 });
    expect(deps.upsertMatters).not.toHaveBeenCalled();
    expect(deps.resolveClearedMatters).not.toHaveBeenCalled();
    expect(deps.saveHabitProfile).toHaveBeenCalledTimes(1);
  });

  it("si falla el guardado de asuntos, no marca el día como hecho (la hora siguiente reintenta todo)", async () => {
    const deps = makeDeps({ upsertMatters: jest.fn(async () => { throw new Error("tabla no existe"); }) });

    const result = await runTenant(tenant, AFTER_BRIEFING, {}, deps);

    expect(result.errors).toEqual(["guardado de asuntos: tabla no existe"]);
    expect(deps.saveHabitProfile).not.toHaveBeenCalled();
  });

  it("lleva la cuenta de creados, actualizados y reabiertos", async () => {
    const deps = makeDeps({
      upsertMatters: jest.fn(async (_t: string, candidates) =>
        candidates.map((c: any, i: number) => ({ change: (["created", "updated"] as const)[i % 2], item: { sk: `s${i}`, ...c } as unknown as MatterItem })),
      ),
    });

    const result = await runTenant(tenant, AFTER_BRIEFING, {}, deps);

    expect(result).toMatchObject({ created: 1, updated: 1, reopened: 0 });
  });
});

describe("resolveSettings", () => {
  it("usa la configuración del negocio cuando es válida", () => {
    expect(resolveSettings({ advisor: { timeZone: "Europe/Madrid", briefingHour: 9 } })).toEqual({ timeZone: "Europe/Madrid", briefingHour: 9 });
  });

  it("sin configuración: Bogotá y las 07:00", () => {
    expect(resolveSettings({})).toEqual({ timeZone: "America/Bogota", briefingHour: 7 });
  });

  it("una zona o una hora inválidas caen al valor por defecto en vez de romper el job", () => {
    expect(resolveSettings({ advisor: { timeZone: "Marte/Olympus", briefingHour: 25 } })).toEqual({ timeZone: "America/Bogota", briefingHour: 7 });
    expect(resolveSettings({ advisor: { briefingHour: 7.5 } }).briefingHour).toBe(7);
  });

  it("la hora 0 (medianoche) es válida", () => {
    expect(resolveSettings({ advisor: { briefingHour: 0 } }).briefingHour).toBe(0);
  });
});
