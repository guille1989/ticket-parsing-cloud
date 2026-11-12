import type { Tool } from "@aws-sdk/client-bedrock-runtime";

import { buildBusinessStatus, type BusinessDay } from "../analytics/engine/businessStatus.js";
import { buildLocationPerformance, type LocationPeriod } from "../analytics/engine/locationPerformance.js";
import { DEFAULT_STAR_DAYS, MAX_STAR_DAYS, MIN_STAR_DAYS, PRODUCT_ROW_LIMIT, loadProductRows, loadProductRowsForDates, loadProductRowsForWindow } from "../analytics/engine/productData.js";
import { buildProductStars } from "../analytics/engine/productStars.js";
import { loadSalesSlots } from "../analytics/engine/salesData.js";
import { buildTomorrowOpportunities, tomorrowReferenceDates } from "../analytics/engine/tomorrowOpportunities.js";
import { buildWeeklyDecline, closedWeekProductWindow, type ProductEvidence, type WeekWindow } from "../analytics/engine/weeklyDecline.js";
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
const BUSINESS_DAYS: BusinessDay[] = ["today", "yesterday"];
const WEEK_WINDOWS: WeekWindow[] = ["current", "last_closed"];

export function analyticsToolSpec(): Tool {
  return {
    toolSpec: {
      name: "analyze_business",
      description:
        "Análisis calculado por el servidor (cifras exactas, misma franja horaria, calidad de datos) para las preguntas guía: " +
        "'business_status_today' (¿cómo va mi negocio hoy/ayer? ventas, tickets y ticket medio; day=today hasta la hora actual o day=yesterday = día local cerrado completo, contra el mismo día de la semana), " +
        "'increase_tomorrow_sales' (¿qué puedo hacer para vender más mañana? pronóstico por día de la semana y hasta 3 acciones con evidencia, rango de impacto, confianza y seguimiento), " +
        "'weekly_sales_decline' (¿por qué vendí menos esta semana / la semana pasada? week=current = semana en curso contra la anterior hasta el mismo día y hora; week=last_closed = semana ISO lun–dom cerrada contra la anterior cerrada), " +
        "'product_stars' (productos estrella: ranking por ingresos, unidades y crecimiento, 30 días completos contra los 30 anteriores) y " +
        "'location_performance' (qué sucursal funciona mejor: un ganador por dimensión; por defecto últimos 7 días cerrados). " +
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
            day: {
              type: "string",
              enum: BUSINESS_DAYS,
              description:
                "Solo para business_status_today: 'today' (parcial hasta el corte, por defecto) o 'yesterday' (día local cerrado completo). Las fechas las calcula el servidor en la TZ del negocio. Usá yesterday si preguntan por ayer.",
            },
            week: {
              type: "string",
              enum: WEEK_WINDOWS,
              description:
                "Solo para weekly_sales_decline: 'current' (semana en curso parcial, por defecto) o 'last_closed' (semana ISO lun–dom ya cerrada). Usá last_closed si preguntan por la semana pasada.",
            },
            period: {
              type: "string",
              enum: PERIODS,
              description:
                "Solo para location_performance: 'last_7_days' (7 días cerrados contra los 7 anteriores, por defecto) o 'today' (hasta la hora actual).",
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
    const day = raw.day === undefined ? "today" : raw.day;
    if (!BUSINESS_DAYS.includes(day as BusinessDay)) throw new Error(`day inválido: "${String(raw.day)}". Válidos: ${BUSINESS_DAYS.join(", ")}`);
    const [rows, branchLabels] = await Promise.all([loadSalesSlots(tenantId, timeZone, now, maxWaitMs), ctx.branchNames()]);
    const result = buildBusinessStatus({ rows, now, timeZone, currency, branch, branchLabels, day: day as BusinessDay });
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
    const week = raw.week === undefined ? "current" : raw.week;
    if (!WEEK_WINDOWS.includes(week as WeekWindow)) throw new Error(`week inválido: "${String(raw.week)}". Válidos: ${WEEK_WINDOWS.join(", ")}`);
    const weekMode = week as WeekWindow;
    // Productos: días cerrados de la ventana pedida. Si falla, el resto del análisis sigue.
    const productWindow = closedWeekProductWindow(now, timeZone, weekMode);
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
      week: weekMode,
    });
    result.quality.warnings.unshift(...zoneWarning);
    return result;
  }

  if (intent === "location_performance") {
    // Default last_7_days: ranking estable para «mejor local» abierto; today solo si lo piden.
    const period = raw.period === undefined ? "last_7_days" : raw.period;
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
