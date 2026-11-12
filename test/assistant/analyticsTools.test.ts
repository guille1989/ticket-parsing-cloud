const mockRunAthenaRows = jest.fn();

jest.mock("../../src/widgets/athenaQuery", () => ({
  runAthenaRows: (...args: unknown[]) => mockRunAthenaRows(...args),
  runWidgetQuery: jest.fn(),
  AthenaTimeoutError: class AthenaTimeoutError extends Error {},
}));

import { analyticsToolSpec, analyzeBusinessTool, type AnalyticsToolContext } from "../../src/assistant/analyticsTools";

const NOW = new Date("2026-11-10T20:40:00Z");

function ctx(overrides: Partial<AnalyticsToolContext> = {}): AnalyticsToolContext {
  return {
    timeZone: "America/Bogota",
    currency: "COP",
    now: NOW,
    branchNames: async () => new Map([["a1", "Centro"]]),
    resolveBranch: async (query) => {
      if (query.toLowerCase() !== "centro") throw new Error(`no existe la sucursal "${query}". Sucursales disponibles: Centro`);
      return { agentId: "a1", label: "Centro" };
    },
    ...overrides,
  };
}

beforeEach(() => mockRunAthenaRows.mockReset());

describe("analyze_business", () => {
  it("expone solo los intents implementados", () => {
    const spec = analyticsToolSpec().toolSpec!;
    const enumValues = (spec.inputSchema as { json: { properties: { intent: { enum: string[] } } } }).json.properties.intent.enum;
    expect(spec.name).toBe("analyze_business");
    expect(enumValues).toEqual(["business_status_today", "weekly_sales_decline", "product_stars", "location_performance", "increase_tomorrow_sales"]);
  });

  it("rechaza un intent desconocido sin consultar Athena", async () => {
    await expect(analyzeBusinessTool({ intent: "pronostico_semanal" }, "t1", ctx())).rejects.toThrow("intent inválido");
    await expect(analyzeBusinessTool({}, "t1", ctx())).rejects.toThrow("intent inválido");
    expect(mockRunAthenaRows).not.toHaveBeenCalled();
  });

  it("el tenant sale del token: viaja como parámetro de la consulta y nunca dentro del SQL", async () => {
    mockRunAthenaRows.mockResolvedValue([{ slot_label: "2026-11-10 10:00", agentid: "a1", sales: "500", tickets: "5" }]);
    const result = (await analyzeBusinessTool({ intent: "business_status_today", tenantId: "otro-tenant" }, "tenant-del-token", ctx())) as {
      intent: string;
      metrics: { sales: number };
    };
    const [sql, params] = mockRunAthenaRows.mock.calls[0];
    expect(params[0]).toBe("tenant-del-token");
    expect(JSON.stringify([sql, params])).not.toContain("otro-tenant");
    expect(result.intent).toBe("business_status_today");
    expect(result.metrics.sales).toBe(500);
  });

  it("una sucursal inexistente propaga el error con las opciones y no consulta datos", async () => {
    await expect(analyzeBusinessTool({ intent: "product_stars", branch: "Sur" }, "t1", ctx())).rejects.toThrow("Sucursales disponibles: Centro");
    expect(mockRunAthenaRows).not.toHaveBeenCalled();
  });

  it("product_stars filtra por la sucursal resuelta y usa 30 días por defecto", async () => {
    mockRunAthenaRows.mockResolvedValue([{ description: "CAFE", period: "current", revenue: "1850", units: "740" }]);
    const result = (await analyzeBusinessTool({ intent: "product_stars", branch: "centro" }, "t1", ctx())) as { context: { branch: string; startDay: string } };
    const [sql, params] = mockRunAthenaRows.mock.calls[0];
    expect(sql).toContain("agentid = ?");
    expect(params[params.length - 1]).toBe("a1");
    expect(result.context).toMatchObject({ branch: "Centro", startDay: "2026-10-11" });
  });

  it("weekly_sales_decline consulta ventas y productos de días cerrados con el tenant del token", async () => {
    mockRunAthenaRows.mockImplementation(async (sql: string) =>
      sql.includes("slot_label")
        ? [
            { slot_label: "2026-11-09 10:00", agentid: "a1", sales: "2000", tickets: "250" },
            { slot_label: "2026-11-02 10:00", agentid: "a1", sales: "2500", tickets: "300" },
          ]
        : [
            { description: "CAFE", period: "current", revenue: "1900", units: "700" },
            { description: "CAFE", period: "previous", revenue: "2400", units: "800" },
          ],
    );
    const result = (await analyzeBusinessTool({ intent: "weekly_sales_decline" }, "tenant-del-token", ctx())) as {
      intent: string;
      metrics: { status: string; delta: number };
      breakdowns: { byProduct: Array<{ name: string }> | null };
    };
    expect(mockRunAthenaRows).toHaveBeenCalledTimes(2);
    for (const [sql, params] of mockRunAthenaRows.mock.calls) {
      expect(params).toContain("tenant-del-token");
      expect(sql).not.toContain("tenant-del-token");
    }
    expect(result.intent).toBe("weekly_sales_decline");
    expect(result.metrics).toMatchObject({ status: "decline", delta: -500 });
    expect(result.breakdowns.byProduct?.[0].name).toBe("CAFE");
  });

  it("weekly_sales_decline sigue sin productos si esa consulta falla", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockRunAthenaRows.mockImplementation(async (sql: string) => {
      if (!sql.includes("slot_label")) throw new Error("athena lenta");
      return [{ slot_label: "2026-11-09 10:00", agentid: "a1", sales: "2000", tickets: "250" }];
    });
    const result = (await analyzeBusinessTool({ intent: "weekly_sales_decline" }, "t1", ctx())) as {
      breakdowns: { byProduct: unknown };
      quality: { warnings: string[] };
    };
    expect(result.breakdowns.byProduct).toBeNull();
    expect(result.quality.warnings.join(" ")).toContain("No se pudo consultar el detalle por producto");
    errorSpy.mockRestore();
  });

  it("increase_tomorrow_sales consulta ventas y productos de los 8 mismos días con el tenant del token", async () => {
    const rowsForDay = (day: string) => [{ slot_label: `${day} 10:00`, agentid: "a1", sales: "1000", tickets: "10" }];
    mockRunAthenaRows.mockImplementation(async (sql: string) =>
      sql.includes("slot_label")
        ? ["2026-09-01", "2026-11-04", "2026-10-28", "2026-10-21", "2026-10-14"].flatMap(rowsForDay)
        : [{ description: "CAFE", period: "current", revenue: "1500", units: "600" }],
    );
    const result = (await analyzeBusinessTool({ intent: "increase_tomorrow_sales" }, "tenant-del-token", ctx())) as {
      intent: string;
      metrics: { status: string; tomorrow: { day: string } };
      recommendations: Array<{ id: string }>;
    };
    expect(mockRunAthenaRows).toHaveBeenCalledTimes(2);
    const productCall = mockRunAthenaRows.mock.calls.find(([sql]) => !String(sql).includes("slot_label"))!;
    expect(productCall[1]).toContain("tenant-del-token");
    expect(productCall[1]).toEqual(expect.arrayContaining(["2026-11-04", "2026-09-16"]));
    expect(result.intent).toBe("increase_tomorrow_sales");
    expect(result.metrics.tomorrow.day).toBe("2026-11-11");
    expect(result.metrics.status).toBe("ok");
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it("valida days, period, day y week antes de consultar", async () => {
    await expect(analyzeBusinessTool({ intent: "product_stars", days: 500 }, "t1", ctx())).rejects.toThrow("days inválido");
    await expect(analyzeBusinessTool({ intent: "product_stars", days: 7.5 }, "t1", ctx())).rejects.toThrow("days inválido");
    await expect(analyzeBusinessTool({ intent: "location_performance", period: "ayer" }, "t1", ctx())).rejects.toThrow("period inválido");
    await expect(analyzeBusinessTool({ intent: "business_status_today", day: "mañana" }, "t1", ctx())).rejects.toThrow("day inválido");
    await expect(analyzeBusinessTool({ intent: "weekly_sales_decline", week: "pasada" }, "t1", ctx())).rejects.toThrow("week inválido");
    expect(mockRunAthenaRows).not.toHaveBeenCalled();
  });

  it("ayer ≠ hoy: day=yesterday fija endDay al día local cerrado y el summary no dice «Hoy llevas»", async () => {
    mockRunAthenaRows.mockResolvedValue([
      { slot_label: "2026-11-09 10:00", agentid: "a1", sales: "900", tickets: "90" },
      { slot_label: "2026-11-09 20:00", agentid: "a1", sales: "300", tickets: "30" },
      { slot_label: "2026-11-02 10:00", agentid: "a1", sales: "800", tickets: "80" },
      { slot_label: "2026-11-02 20:00", agentid: "a1", sales: "200", tickets: "20" },
      { slot_label: "2026-11-10 10:00", agentid: "a1", sales: "50", tickets: "5" },
    ]);
    const result = (await analyzeBusinessTool({ intent: "business_status_today", day: "yesterday" }, "t1", ctx())) as {
      context: { startDay: string; endDay: string; cutoffLocal: string | null };
      metrics: { sales: number };
      summary: string;
    };
    expect(result.context).toMatchObject({ startDay: "2026-11-09", endDay: "2026-11-09", cutoffLocal: null });
    expect(result.metrics.sales).toBe(1200);
    expect(result.summary.startsWith("Hoy llevas")).toBe(false);
    expect(result.summary).toContain("Ayer");
  });

  it("semana pasada: week=last_closed usa lun–dom cerrados, no lun→hoy", async () => {
    mockRunAthenaRows.mockImplementation(async (sql: string) =>
      sql.includes("slot_label")
        ? [
            { slot_label: "2026-11-02 10:00", agentid: "a1", sales: "1000", tickets: "100" },
            { slot_label: "2026-11-08 10:00", agentid: "a1", sales: "500", tickets: "50" },
            { slot_label: "2026-10-26 10:00", agentid: "a1", sales: "1200", tickets: "120" },
            { slot_label: "2026-11-01 10:00", agentid: "a1", sales: "600", tickets: "60" },
            { slot_label: "2026-11-10 10:00", agentid: "a1", sales: "9999", tickets: "999" },
          ]
        : [],
    );
    const result = (await analyzeBusinessTool({ intent: "weekly_sales_decline", week: "last_closed" }, "t1", ctx())) as {
      metrics: { window: { currentFrom: string; currentTo: string; cutoffLocal: string | null }; current: { sales: number } };
      summary: string;
    };
    expect(result.metrics.window).toMatchObject({
      currentFrom: "2026-11-02",
      currentTo: "2026-11-08",
      cutoffLocal: null,
    });
    expect(result.metrics.current.sales).toBe(1500);
    expect(result.summary).toContain("semana pasada");
  });

  it("mejor local sin period: default last_7_days (no today parcial)", async () => {
    mockRunAthenaRows.mockResolvedValue([]);
    const result = (await analyzeBusinessTool({ intent: "location_performance" }, "t1", ctx())) as {
      metrics: { period: string };
      context: { comparison: string };
    };
    expect(result.metrics.period).toBe("last_7_days");
    expect(result.context.comparison).toContain("7 días cerrados");
    const props = (analyticsToolSpec().toolSpec!.inputSchema as { json: { properties: { period: { description: string } } } }).json.properties;
    expect(props.period.description).toContain("por defecto");
    expect(props.period.description).toContain("last_7_days");
  });

  it("sin zona horaria usa UTC y lo advierte; la moneda vacía no se inventa", async () => {
    mockRunAthenaRows.mockResolvedValue([]);
    const result = (await analyzeBusinessTool({ intent: "location_performance" }, "t1", ctx({ timeZone: undefined, currency: undefined }))) as {
      context: { timezone: string; currency: string | null };
      quality: { warnings: string[] };
      metrics: { period: string };
    };
    expect(result.context).toMatchObject({ timezone: "UTC", currency: null });
    expect(result.quality.warnings[0]).toContain("UTC");
    expect(result.metrics.period).toBe("last_7_days");
  });

  it("pasa el plazo restante a Athena para no pasarse del corte de API Gateway", async () => {
    mockRunAthenaRows.mockResolvedValue([]);
    await analyzeBusinessTool({ intent: "business_status_today" }, "t1", ctx({ deadline: Date.now() + 5_000 }));
    const maxWaitMs = mockRunAthenaRows.mock.calls[0][3] as number;
    expect(maxWaitMs).toBeGreaterThan(1_000);
    expect(maxWaitMs).toBeLessThanOrEqual(5_000);
  });
});
