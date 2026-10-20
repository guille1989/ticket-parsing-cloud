import {
  analyticsInputsFromTicket,
  batchedDemoKeys,
  diffAnalytics,
  fingerprintBody,
  type AnalyticsObject,
  type ReconTicket,
} from "../../src/analytics/reconcile";
import { analyticsRowKey, buildAnalyticsBody } from "../../src/analytics/writeAnalyticsRows";

function ticket(overrides: Partial<ReconTicket> = {}): ReconTicket {
  return {
    tenantId: "t1",
    ticketId: "tk1",
    capturedAt: "2026-10-05T15:00:00.000Z",
    port: "COM3",
    status: "parsed",
    parsedBy: "deterministic",
    items: [
      { description: "Empanada", quantity: 2, unitPrice: 2500, subtotal: 5000 },
      { description: "Gaseosa", quantity: 1, unitPrice: 1100, subtotal: 1100 },
    ],
    total: 6100,
    ...overrides,
  };
}

/** El objeto que el flujo normal habría escrito para este ticket. */
function objectFor(t: ReconTicket, withContent = true): AnalyticsObject {
  const inputs = analyticsInputsFromTicket(t)!;
  return {
    key: analyticsRowKey(t.tenantId, t.capturedAt, t.ticketId),
    fingerprint: withContent ? fingerprintBody(buildAnalyticsBody(inputs.ctx, inputs.parsed)) : undefined,
  };
}

test("ticket y analítica coherentes: sin diferencias", () => {
  const t = ticket();
  expect(diffAnalytics([t], [objectFor(t)])).toEqual([]);
});

test("venta guardada sin objeto en analítica: missing", () => {
  const t = ticket();
  expect(diffAnalytics([t], [])).toEqual([
    { kind: "missing", ticketId: "tk1", key: analyticsRowKey("t1", t.capturedAt, "tk1"), ticketStatus: "parsed" },
  ]);
});

test("needs_review también debe estar en analítica", () => {
  const t = ticket({ status: "needs_review" });
  expect(diffAnalytics([t], []).map((d) => d.kind)).toEqual(["missing"]);
});

test("ticket descartado cuyo objeto sigue ahí: orphan discarded", () => {
  const live = ticket();
  const discarded = ticket({ status: "discarded" });
  const result = diffAnalytics([discarded], [{ key: objectFor(live).key }]);
  expect(result).toEqual([{ kind: "orphan", ticketId: "tk1", key: objectFor(live).key, reason: "discarded" }]);
});

test("estado desactualizado (confirmado pero la analítica dice needs_review): stale", () => {
  const stored = ticket({ status: "parsed" });
  const old = objectFor(ticket({ status: "needs_review" }));
  const [d] = diffAnalytics([stored], [{ ...old, key: objectFor(stored).key }]);
  expect(d.kind).toBe("stale");
  expect(d.kind === "stale" && d.differences[0]).toContain("estado");
});

test("importe desactualizado: stale con el total y los subtotales", () => {
  const stored = ticket({ total: 6100 });
  const old = objectFor(ticket({ total: 5000, items: [{ description: "Empanada", quantity: 2, unitPrice: 2500, subtotal: 5000 }] }));
  const [d] = diffAnalytics([stored], [{ ...old, key: objectFor(stored).key }]);
  expect(d.kind === "stale" && d.differences.join(" | ")).toMatch(/total.*ítems.*subtotales/);
});

test("sin leer contenido solo se compara la existencia", () => {
  const stored = ticket();
  expect(diffAnalytics([stored], [objectFor(stored, false)])).toEqual([]);
});

test("objeto ilegible: stale", () => {
  const t = ticket();
  const [d] = diffAnalytics([t], [{ key: objectFor(t).key, fingerprint: fingerprintBody("{no es json") }]);
  expect(d.kind === "stale" && d.differences[0]).toContain("ilegible");
});

test("objeto de un ticket que no existe: orphan unknown-ticket", () => {
  const result = diffAnalytics([], [{ key: "tenant=t1/year=2026/month=10/fantasma.jsonl" }]);
  expect(result).toEqual([{ kind: "orphan", ticketId: "fantasma", key: "tenant=t1/year=2026/month=10/fantasma.jsonl", reason: "unknown-ticket" }]);
});

test("mismo ticket en otra clave (capturedAt cambió de mes): missing + orphan duplicate-key", () => {
  const t = ticket({ capturedAt: "2026-11-01T00:30:00.000Z" });
  const stale = { key: "tenant=t1/year=2026/month=10/tk1.jsonl" };
  const kinds = diffAnalytics([t], [stale]).map((d) => (d.kind === "orphan" ? `orphan:${d.reason}` : d.kind)).sort();
  expect(kinds).toEqual(["missing", "orphan:duplicate-key"]);
});

test("ticket pending con objeto (reproceso en curso): orphan pending, para que el script no lo borre", () => {
  const live = ticket();
  const [d] = diffAnalytics([ticket({ status: "pending" })], [{ key: objectFor(live).key }]);
  expect(d).toMatchObject({ kind: "orphan", reason: "pending" });
});

test("ticket parsed sin ítems no exige objeto", () => {
  expect(diffAnalytics([ticket({ items: [] })], [])).toEqual([]);
});

test("analyticsInputsFromTicket: tickets antiguos sin parsedBy se tratan como determinísticos; descartados no producen filas", () => {
  expect(analyticsInputsFromTicket(ticket({ parsedBy: undefined }))?.ctx.parsedBy).toBe("deterministic");
  expect(analyticsInputsFromTicket(ticket({ status: "discarded" }))).toBeUndefined();
});

test("la reescritura de un ticket cuadra con su propia huella (reparar deja el diff vacío)", () => {
  const t = ticket({ tax: 400, discount: 100, tip: 200 });
  expect(diffAnalytics([t], [objectFor(t)])).toEqual([]);
});

test("batchedDemoKeys detecta el layout agrupado del demo y no confunde tickets reales", () => {
  const keys = [
    "tenant=d3a1/year=2026/month=10/demo-chamberi-2026-10-05.jsonl",
    "tenant=d3a1/year=2026/month=10/0b8c1f7e-aaaa-bbbb-cccc-111122223333.jsonl",
  ];
  expect(batchedDemoKeys(keys)).toEqual([keys[0]]);
  expect(batchedDemoKeys([keys[1]])).toEqual([]);
});
