const mockDdbSend = jest.fn();

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => mockDdbSend(...args) }, WIDGETS_TABLE: "TestWidgets" };
});

import { listWidgetsTool } from "../../src/assistant/widgetTools";

beforeEach(() => {
  mockDdbSend.mockReset();
});

test("lista widgets con resumen de filtros y respeta el tope", async () => {
  mockDdbSend.mockResolvedValue({
    Items: [
      {
        widgetId: "w1",
        name: "Ventas totales",
        visualization: "kpi",
        metric: { field: "total", aggregation: "sum" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        widgetId: "w2",
        name: "Café · Sol",
        visualization: "kpi",
        metric: { field: "subtotal", aggregation: "sum" },
        secondaryMetric: { field: "quantity", aggregation: "sum" },
        filters: { agentId: "a1", descriptionContains: "cafe" },
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      {
        widgetId: "w3",
        name: "Por día",
        visualization: "line",
        metric: { field: "total", aggregation: "sum" },
        groupBy: "day",
        createdAt: "2026-01-03T00:00:00.000Z",
      },
    ],
  });

  const result = (await listWidgetsTool({ limit: 2 }, "t1")) as {
    widgets: Array<Record<string, unknown>>;
    count: number;
    total: number;
  };

  expect(result.total).toBe(3);
  expect(result.count).toBe(2);
  expect(result.widgets[0]).toEqual({
    widgetId: "w1",
    title: "Ventas totales",
    chartType: "kpi",
    field: "total",
    aggregation: "sum",
  });
  expect(result.widgets[1]).toMatchObject({
    widgetId: "w2",
    title: "Café · Sol",
    secondaryField: "quantity",
    filters: { descriptionContains: "cafe", branch: "(filtrado por sucursal)" },
  });
  expect(JSON.stringify(result.widgets[1])).not.toContain("a1");
});

test("limit inválido lanza", async () => {
  await expect(listWidgetsTool({ limit: 0 }, "t1")).rejects.toThrow(/limit/);
});
