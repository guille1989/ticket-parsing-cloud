import { createFakeDynamo } from "./fakeDynamo";

const fake = createFakeDynamo();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => fake.send(args[0]) }, MATTERS_TABLE: "TestMatters" };
});

import {
  listMatters,
  markMatter,
  matterIdOf,
  parseMatterId,
  resolveClearedMatters,
  upsertMatters,
} from "../../src/travis/matterStore";
import type { MatterCandidate } from "../../src/travis/types";

const T = "t1";
const TODAY = "2026-11-04";
const at = (iso: string) => new Date(iso);
const T0 = at("2026-11-04T07:00:00Z");
const T1 = at("2026-11-04T08:00:00Z");

function offline(overrides: Partial<MatterCandidate> = {}): MatterCandidate {
  return {
    detector: "agent_offline",
    scope: "branch:a1",
    periodDate: TODAY,
    severity: "warn",
    evidence: { agentId: "a1", minutesSinceSeen: 45 },
    ...overrides,
  };
}

const anomaly: MatterCandidate = {
  detector: "sales_anomaly",
  scope: "total",
  periodDate: "2026-11-03",
  severity: "critical",
  expected: 400,
  actual: 200,
  evidence: { direction: "drop", deltaPct: -50 },
};

const stored = (candidate: MatterCandidate) => fake.get(`TENANT#${T}`, `MATTER#${candidate.periodDate}#${candidate.detector}#${candidate.scope}`)!;

beforeEach(() => {
  fake.items.clear();
});

describe("upsertMatters", () => {
  it("un asunto nuevo queda en new, con TTL de 90 días y sin campos undefined", async () => {
    const [result] = await upsertMatters(T, [offline()], T0);

    expect(result.change).toBe("created");
    expect(stored(offline())).toMatchObject({
      pk: "TENANT#t1",
      sk: "MATTER#2026-11-04#agent_offline#branch:a1",
      status: "new",
      createdAt: T0.toISOString(),
      ttl: Math.floor(T0.getTime() / 1000) + 90 * 86_400,
    });
    expect(stored(offline())).not.toHaveProperty("expected");
  });

  it("correr dos veces lo mismo no duplica: actualiza cifras y conserva createdAt", async () => {
    await upsertMatters(T, [offline()], T0);
    const [again] = await upsertMatters(T, [offline({ evidence: { agentId: "a1", minutesSinceSeen: 105 } })], T1);

    expect(again.change).toBe("updated");
    expect(fake.items.size).toBe(1);
    expect(stored(offline())).toMatchObject({ createdAt: T0.toISOString(), updatedAt: T1.toISOString(), evidence: { minutesSinceSeen: 105 } });
  });

  it("lo que el dueño ya vio sigue visto si la cosa no empeora", async () => {
    await upsertMatters(T, [offline()], T0);
    await markMatter(T, matterIdOf(offline()), "seen", T0);

    const [again] = await upsertMatters(T, [offline()], T1);

    expect(again.change).toBe("updated");
    expect(stored(offline()).status).toBe("seen");
  });

  it("si empeora de severidad después de que lo vio o lo descartó, vuelve a new", async () => {
    await upsertMatters(T, [offline()], T0);
    await markMatter(T, matterIdOf(offline()), "dismissed", T0);

    const [escalated] = await upsertMatters(T, [offline({ severity: "critical" })], T1);

    expect(escalated.change).toBe("reopened");
    expect(stored(offline())).toMatchObject({ status: "new", severity: "critical" });
  });

  it("un asunto resuelto que reaparece vuelve a new", async () => {
    await upsertMatters(T, [offline()], T0);
    await resolveClearedMatters(T, TODAY, ["agent_offline"], new Set(), T1);
    expect(stored(offline()).status).toBe("resolved");

    const [back] = await upsertMatters(T, [offline()], at("2026-11-04T09:00:00Z"));

    expect(back.change).toBe("reopened");
    expect(stored(offline()).status).toBe("new");
  });

  it("un descartado de ayer sigue descartado hoy mientras el problema continúa igual", async () => {
    const yesterday = offline({ periodDate: "2026-11-03" });
    await upsertMatters(T, [yesterday], at("2026-11-03T20:00:00Z"));
    await markMatter(T, matterIdOf(yesterday), "dismissed", at("2026-11-03T20:05:00Z"));

    const [today] = await upsertMatters(T, [offline()], T0);

    expect(today.change).toBe("created");
    expect(stored(offline()).status).toBe("dismissed");
  });

  it("pero si hoy está peor que lo que descartó, avisa de nuevo", async () => {
    const yesterday = offline({ periodDate: "2026-11-03" });
    await upsertMatters(T, [yesterday], at("2026-11-03T20:00:00Z"));
    await markMatter(T, matterIdOf(yesterday), "dismissed", at("2026-11-03T20:05:00Z"));

    await upsertMatters(T, [offline({ severity: "critical" })], T0);

    expect(stored(offline()).status).toBe("new");
  });

  it("una venta anómala es un evento de un día: no hereda nada de otros días", async () => {
    const earlier = { ...anomaly, periodDate: "2026-11-02" };
    await upsertMatters(T, [earlier], at("2026-11-03T07:00:00Z"));
    await markMatter(T, matterIdOf(earlier), "dismissed", at("2026-11-03T07:05:00Z"));

    await upsertMatters(T, [anomaly], T0);

    expect(stored(anomaly).status).toBe("new");
  });

  it("rechaza un scope que rompería la clave", async () => {
    await expect(upsertMatters(T, [offline({ scope: "a#b" })], T0)).rejects.toThrow("scope inválido");
  });
});

describe("resolveClearedMatters", () => {
  it("resuelve los asuntos de estado que ya no se detectan y deja los que siguen activos", async () => {
    const other = offline({ scope: "branch:a2" });
    await upsertMatters(T, [offline(), other], T0);
    const active = new Set([stored(other).sk]);

    const resolved = await resolveClearedMatters(T, TODAY, ["agent_offline"], active, T1);

    expect(resolved).toBe(1);
    expect(stored(offline())).toMatchObject({ status: "resolved", resolvedAt: T1.toISOString() });
    expect(stored(other).status).toBe("new");
  });

  it("si el detector no corrió en esta pasada, no puede afirmar que el problema terminó", async () => {
    await upsertMatters(T, [offline()], T0);

    expect(await resolveClearedMatters(T, TODAY, ["review_backlog"], new Set(), T1)).toBe(0);
    expect(stored(offline()).status).toBe("new");
  });

  it("no resuelve las ventas anómalas (son eventos, no estados) ni toca lo descartado", async () => {
    await upsertMatters(T, [anomaly, offline()], T0);
    await markMatter(T, matterIdOf(offline()), "dismissed", T0);

    await resolveClearedMatters(T, TODAY, ["agent_offline", "sales_anomaly"], new Set(), T1);

    expect(stored(anomaly).status).toBe("new");
    expect(stored(offline()).status).toBe("dismissed");
  });

  it("cierra también lo que quedó abierto ayer", async () => {
    const yesterday = offline({ periodDate: "2026-11-03" });
    await upsertMatters(T, [yesterday], at("2026-11-03T20:00:00Z"));

    await resolveClearedMatters(T, TODAY, ["agent_offline"], new Set(), T0);

    expect(stored(yesterday).status).toBe("resolved");
  });
});

describe("markMatter", () => {
  it("marca como visto y luego descartado, guardando cuándo lo vio por primera vez", async () => {
    await upsertMatters(T, [offline()], T0);

    const seen = await markMatter(T, matterIdOf(offline()), "seen", T0);
    const dismissed = await markMatter(T, matterIdOf(offline()), "dismissed", T1);

    expect(seen).toMatchObject({ ok: true, item: { status: "seen", seenAt: T0.toISOString() } });
    expect(dismissed).toMatchObject({ ok: true, item: { status: "dismissed", seenAt: T0.toISOString(), updatedAt: T1.toISOString() } });
  });

  it("un asunto que no existe, o un id mal formado, es not_found", async () => {
    expect(await markMatter(T, "2026-11-04#agent_offline#branch:zzz", "seen", T0)).toEqual({ ok: false, reason: "not_found" });
    expect(await markMatter(T, "basura", "seen", T0)).toEqual({ ok: false, reason: "not_found" });
  });

  it("un asunto resuelto ya no se puede marcar", async () => {
    await upsertMatters(T, [offline()], T0);
    await resolveClearedMatters(T, TODAY, ["agent_offline"], new Set(), T1);

    expect(await markMatter(T, matterIdOf(offline()), "dismissed", T1)).toEqual({ ok: false, reason: "resolved" });
  });

  it("no toca los asuntos de otro tenant", async () => {
    await upsertMatters("otro", [offline()], T0);

    expect(await markMatter(T, matterIdOf(offline()), "dismissed", T1)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("listMatters", () => {
  it("devuelve desde la fecha pedida, el más reciente primero, y solo del tenant", async () => {
    await upsertMatters(T, [{ ...anomaly, periodDate: "2026-10-01" }, anomaly, offline()], T0);
    await upsertMatters("otro", [offline()], T0);

    const items = await listMatters(T, "2026-11-01");

    expect(items.map((item) => item.sk)).toEqual([
      "MATTER#2026-11-04#agent_offline#branch:a1",
      "MATTER#2026-11-03#sales_anomaly#total",
    ]);
  });
});

describe("matterId", () => {
  it("ida y vuelta, incluido un scope con dos puntos", () => {
    const id = matterIdOf({ periodDate: "2026-11-04", detector: "capture_zero", scope: "branch:abc-1" });
    expect(parseMatterId(id)).toEqual({ periodDate: "2026-11-04", detector: "capture_zero", scope: "branch:abc-1" });
  });

  it("rechaza detectores desconocidos y formatos raros", () => {
    expect(parseMatterId("2026-11-04#inventado#total")).toBeNull();
    expect(parseMatterId("2026-11-04#agent_offline#")).toBeNull();
    expect(parseMatterId("../etc#passwd")).toBeNull();
  });
});
