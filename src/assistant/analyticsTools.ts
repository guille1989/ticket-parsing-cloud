import type { Tool } from "@aws-sdk/client-bedrock-runtime";

import { buildBusinessStatus } from "../analytics/engine/businessStatus.js";
import { buildLocationPerformance, type LocationPeriod } from "../analytics/engine/locationPerformance.js";
import { DEFAULT_STAR_DAYS, MAX_STAR_DAYS, MIN_STAR_DAYS, PRODUCT_ROW_LIMIT, loadProductRows, loadProductRowsForDates, loadProductRowsForWindow } from "../analytics/engine/productData.js";
import { buildProductStars } from "../analytics/engine/productStars.js";
import { loadSalesSlots } from "../analytics/engine/salesData.js";
import { buildTomorrowOpportunities, tomorrowReferenceDates } from "../analytics/engine/tomorrowOpportunities.js";
import { buildWeeklyDecline, closedWeekProductWindow, type ProductEvidence } from "../analytics/engine/weeklyDecline.js";
import { IMPLEMENTED_INTENTS, type ImplementedIntent } from "../analytics/engine/types.js";

/** Lo que la herramienta necesita del handler: zona, moneda, plazo y el catálogo de sucursales del tenant. */
export interface AnalyticsToolContext {
  timeZone?: string;
  currency?: string;
  /** Instante (ms epoch) hasta el que las consultas pueden esperar. */
  deadline?: number;
  /** agentId -> nombre visible de la sucursal. */
  branchNames: () => Promise<Map<string, string>>;
  /** Resuelve el nombre dicho por el usuario a la sucursal (lanza con las opciones si no existe o es ambigua). */
  resolveBranch: (query: string) => Promise<{ agentId: string; label: string }>;
  /** Solo para pruebas. */
  now?: Date;
}

const PERIODS: LocationPeriod[] = ["today", "last_7_days"];

export function analyticsToolSpec(): Tool {
  return {
    toolSpec: {
      name: "analyze_business",
      description:
        "Análisis calculado por el servidor (cifras exactas, misma franja horaria, calidad de datos) para las preguntas guía: " +
        "'business_status_today' (¿cómo va mi negocio hoy? ventas, tickets y ticket medio hasta la hora actual contra el mismo día de la semana pasada), " +
        "'increase_tomorrow_sales' (¿qué puedo hacer para vender más mañana? pronóstico por día de la semana y hasta 3 acciones con evidencia, rango de impacto, confianza y seguimiento), " +
        "'weekly_sales_decline' (¿por qué vendí menos esta semana? la semana en curso contra la anterior hasta el mismo día y hora, descompuesta en tickets y ticket medio, con sucursal, día, hora y producto de mayor caída), " +
        "'product_stars' (productos estrella: ranking por ingresos, unidades y crecimiento, 30 días completos contra los 30 anteriores) y " +
        "'location_performance' (qué sucursal funciona mejor: un ganador por dimensión). " +
        "Usala SIEMPRE para esas preguntas en vez de armar los cálculos con run_widget_query. Devuelve un 'summary' ya redactado y los datos: respondé con esas cifras tal cual, sin recalcular ni inventar.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            intent: { type: "string", enum: [...IMPLEMENTED_INTENTS], description: "Qué análisis calcular." },
            branch: {
              type: "string",
              description: "Solo para business_status_today, weekly_sales_decline, increase_tomorrow_sales y product_stars: limitar a esta sucursal, por su nombre tal cual lo dijo el usuario (opcional).",
            },
            period: {
              type: "string",
              enum: PERIODS,
              description: "Solo para location_performance: 'today' (hasta la hora actual, por defecto) o 'last_7_days' (7 días cerrados contra los 7 anteriores).",
            },
            days: {
              type: "number",
              description: `Solo para product_stars: días completos del periodo (por defecto ${DEFAULT_STAR_DAYS}, entre ${MIN_STAR_DAYS} y ${MAX_STAR_DAYS}).`,
            },
          },
          required: ["intent"],
        },
      },
    },
  };
}

function isImplementedIntent(value: unknown): value is ImplementedIntent {
  return typeof value === "string" && (IMPLEMENTED_INTENTS as readonly string[]).includes(value);
}

/**
 * Ejecuta un análisis determinista. El tenant sale siempre del token (lo pasa el handler): el modelo
 * no elige de quién son los datos. Las fechas y la zona las fija el servidor, no el modelo.
 */
export async function analyzeBusinessTool(input: unknown, tenantId: string, ctx: AnalyticsToolContext): Promise<unknown> {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (!isImplementedIntent(raw.intent)) {
    throw new Error(`intent inválido: "${String(raw.intent)}". Válidos: ${IMPLEMENTED_INTENTS.join(", ")}`);
  }
  const intent = raw.intent;
  const now = ctx.now ?? new Date();
  const timeZone = ctx.timeZone ?? "UTC";
  const currency = ctx.currency?.trim() || null;
  const maxWaitMs = ctx.deadline === undefined ? undefined : Math.max(1_000, ctx.deadline - Date.now());
  const zoneWarning = ctx.timeZone ? [] : ["No hay zona horaria del negocio ni del usuario: las horas están en UTC."];

  const branch =
    typeof raw.branch === "string" && raw.branch.trim() && intent !== "location_performance"
      ? await ctx.resolveBranch(raw.branch.trim())
      : undefined;

  if (intent === "business_status_today") {
    const [rows, branchLabels] = await Promise.all([loadSalesSlots(tenantId, timeZone, now, maxWaitMs), ctx.branchNames()]);
    const result = buildBusinessStatus({ rows, now, timeZone, currency, branch, branchLabels });
    result.quality.warnings.unshift(...zoneWarning);
    return result;
  }

  if (intent === "increase_tomorrow_sales") {
    const { dates } = tomorrowReferenceDates(now, timeZone);
    let productsFailed = false;
    const productsPromise = loadProductRowsForDates(tenantId, timeZone, now, dates, branch?.agentId, maxWaitMs).then(
      (productRows) => ({ rows: productRows, truncated: productRows.length >= PRODUCT_ROW_LIMIT }),
      (err: unknown) => {
        console.error("[assistant] no se pudo consultar productos de las oportunidades de mañana:", err);
        productsFailed = true;
        return undefined;
      },
    );
    const [rows, products] = await Promise.all([loadSalesSlots(tenantId, timeZone, now, maxWaitMs), productsPromise]);
    const result = buildTomorrowOpportunities({ rows, now, timeZone, currency, branch, products, productsStatus: productsFailed ? "failed" : undefined });
    result.quality.warnings.unshift(...zoneWarning);
    return result;
  }

  if (intent === "weekly_sales_decline") {
    // Productos: solo días cerrados (hoy no tiene corte por hora en esa consulta). Si falla, el resto del análisis sigue.
    const productWindow = closedWeekProductWindow(now, timeZone);
    const productsPromise: Promise<{ evidence?: ProductEvidence; failed: boolean }> = productWindow
      ? loadProductRowsForWindow(tenantId, timeZone, now, productWindow, branch?.agentId, maxWaitMs).then(
          (productRows) => ({ evidence: { rows: productRows, window: productWindow, truncated: productRows.length >= PRODUCT_ROW_LIMIT }, failed: false }),
          (err: unknown) => {
            console.error("[assistant] no se pudo consultar productos del análisis semanal:", err);
            return { failed: true };
          },
        )
      : Promise.resolve({ failed: false });
    const [rows, branchLabels, products] = await Promise.all([loadSalesSlots(tenantId, timeZone, now, maxWaitMs), ctx.branchNames(), productsPromise]);
    const result = buildWeeklyDecline({
      rows,
      now,
      timeZone,
      currency,
      branch,
      branchLabels,
      products: products.evidence,
      productsStatus: products.failed ? "failed" : "no_closed_days",
    });
    result.quality.warnings.unshift(...zoneWarning);
    return result;
  }

  if (intent === "location_performance") {
    const period = raw.period === undefined ? "today" : raw.period;
    if (!PERIODS.includes(period as LocationPeriod)) throw new Error(`period inválido: "${String(raw.period)}". Válidos: ${PERIODS.join(", ")}`);
    const [rows, branchLabels] = await Promise.all([loadSalesSlots(tenantId, timeZone, now, maxWaitMs), ctx.branchNames()]);
    const result = buildLocationPerformance({ rows, now, timeZone, currency, period: period as LocationPeriod, branchLabels });
    result.quality.warnings.unshift(...zoneWarning);
    return result;
  }

  // product_stars
  let days = DEFAULT_STAR_DAYS;
  if (raw.days !== undefined) {
    if (typeof raw.days !== "number" || !Number.isInteger(raw.days) || raw.days < MIN_STAR_DAYS || raw.days > MAX_STAR_DAYS) {
      throw new Error(`days inválido: se esperaba un entero entre ${MIN_STAR_DAYS} y ${MAX_STAR_DAYS}`);
    }
    days = raw.days;
  }
  const rows = await loadProductRows(tenantId, timeZone, now, days, branch?.agentId, maxWaitMs);
  const result = buildProductStars({ rows, now, timeZone, currency, days, branchLabel: branch?.label, truncated: rows.length >= PRODUCT_ROW_LIMIT });
  result.quality.warnings.unshift(...zoneWarning);
  return result;
}
