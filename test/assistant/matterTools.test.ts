import { createFakeDynamo } from "../advisor/fakeDynamo";

const fake = createFakeDynamo();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => fake.send(args[0]) }, MATTERS_TABLE: "TestMatters", AGENTS_TABLE: "TestAgents" };
});

import { publicMatterId } from "../../src/advisor/matterApi";
import { upsertMatters } from "../../src/advisor/matterStore";
import { explainMatterTool, listMattersTool, matterChecks } from "../../src/assistant/matterTools";
import type { MatterCandidate } from "../../src/advisor/types";

const today = () => new Date().toISOString().slice(0, 10);

function matter(overrides: Partial<MatterCandidate> = {}): MatterCandidate {
  return {
    detector: "agent_offline",
    scope: "branch:a1",
    periodDate: today(),
    severity: "warn",
    evidence: { agentName: "Caja 1", minutesSinceSeen: 40 },
    ...overrides,
  };
}

beforeEach(() => {
  fake.items.clear();
  fake.items.set("TENANT#t1|AGENT#a1", {
    pk: "TENANT#t1",
    sk: "AGENT#a1",
    agentId: "a1",
    name: "Caja 1",
    location: { label: "Sede Norte" },
  });
});

describe("matterChecks", () => {
  it("sugiere chequeos concretos sin diagnosticar hardware", () => {
    expect(matterChecks("agent_offline").some((c) => /encendido|internet/i.test(c))).toBe(true);
    expect(matterChecks("sales_anomaly").some((c) => /Contrastá|run_widget/i.test(c))).toBe(true);
  });
});

describe("listMattersTool", () => {
  it("lista avisos abiertos con id público y tope de limit", async () => {
    await upsertMatters("t1", [
      matter(),
      matter({ detector: "review_backlog", scope: "total", severity: "critical", evidence: { pendingTickets: 3 } }),
      matter({
        detector: "sales_anomaly",
        scope: "total",
        severity: "info",
        evidence: { deltaPct: -40, direction: "drop" },
        expected: 100,
        actual: 60,
      }),
    ]);

    const result = (await listMattersTool({ limit: 2 }, "t1")) as {
      matters: Array<{ id: string; detector: string; branchLabel: string | null }>;
      openCount: number;
    };

    expect(result.matters).toHaveLength(2);
    expect(result.openCount).toBe(3);
    expect(result.matters[0].id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.matters.some((m) => m.branchLabel === "Sede Norte")).toBe(true);
  });

  it("rechaza status inválido", async () => {
    await expect(listMattersTool({ status: ["nope"] }, "t1")).rejects.toThrow(/status inválido/);
  });
});

describe("explainMatterTool", () => {
  it("explica un aviso por id público con checks", async () => {
    const [created] = await upsertMatters("t1", [matter({ detector: "capture_zero", expected: 8, actual: 0, evidence: { windowHours: 3, agentName: "Caja 1" } })]);
    const matterId = publicMatterId(created.item);

    const result = (await explainMatterTool({ matterId }, "t1")) as {
      detector: string;
      expected: number;
      checks: string[];
      branchLabel: string | null;
    };

    expect(result.detector).toBe("capture_zero");
    expect(result.expected).toBe(8);
    expect(result.branchLabel).toBe("Sede Norte");
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it("rechaza matterId basura y aviso inexistente", async () => {
    await expect(explainMatterTool({ matterId: "!!!" }, "t1")).rejects.toThrow(/matterId inválido/);
    const missing = Buffer.from(`${today()}#agent_offline#branch:ghost`, "utf-8").toString("base64url");
    await expect(explainMatterTool({ matterId: missing }, "t1")).rejects.toThrow(/no encontrado/);
  });
});
