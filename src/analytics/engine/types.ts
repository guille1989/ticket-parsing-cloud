/**
 * Motor analítico determinista de los prompts sugeridos del asistente.
 *
 * Principio: las cifras, fechas y comparaciones las calcula este código; el modelo
 * solo las redacta. Cada intent devuelve el mismo contrato (`AnalysisResponse`) con
 * calidad de datos explícita y un `summary` determinista que sirve de respaldo si el
 * modelo no está disponible.
 */

export type IntentId =
  | "business_status_today"
  | "weekly_sales_decline"
  | "product_stars"
  | "location_performance"
  | "increase_tomorrow_sales";

/** Los cinco intents del documento de especificación. `increase_tomorrow_sales` es la versión reducida (sin costes, stock ni ventas cruzadas). */
export const IMPLEMENTED_INTENTS = ["business_status_today", "weekly_sales_decline", "product_stars", "location_performance", "increase_tomorrow_sales"] as const;
export type ImplementedIntent = (typeof IMPLEMENTED_INTENTS)[number];

export type Confidence = "high" | "medium" | "low";

/** observado = salió de los tickets; estimado = cálculo sobre supuestos; hipótesis = a validar, sin evidencia causal. */
export type InsightKind = "observed" | "estimated" | "hypothesis";

export interface Insight {
  id: string;
  kind: InsightKind;
  headline: string;
  evidenceRefs: string[];
  confidence: Confidence;
}

/**
 * Una acción concreta para la siguiente jornada. Cada campo responde a lo que el documento exige:
 * qué hacer, por qué (con la métrica que lo sustenta), cuándo/dónde, impacto, confianza y seguimiento.
 */
export interface Recommendation {
  id: string;
  kind: "weak_slot" | "protect_leader" | "peak_coverage";
  /** 1 = la de mayor prioridad. */
  priority: number;
  what: string;
  why: string;
  where: { branch: string | null; day: string; hours: string | null; product: string | null };
  impact: {
    /** false = no se puede cuantificar con los datos disponibles (no se inventa un número). */
    available: boolean;
    /** Rango de escenario en ventas, no una promesa. */
    revenue: { low: number; high: number } | null;
    assumption: string | null;
    /** Sin costes cargados no hay margen. */
    margin: { available: false; reason: string };
  };
  confidence: Confidence;
  confidenceReason: string;
  followUp: string;
  evidenceRefs: string[];
}

export interface AnalysisQuality {
  /** complete = hay datos del periodo y referencia; partial = faltan referencia o piezas; no_data = ninguna transacción observada. */
  status: "complete" | "partial" | "no_data";
  /** Hora local (HH:MM) de la franja más reciente con ventas dentro de la ventana consultada; null si no hubo. */
  lastSaleAt: string | null;
  /** % de ventas con detalle de producto; null = no medido. */
  productCoveragePct: number | null;
  /** Siempre null por ahora: no hay costes cargados. Null es "no disponible", nunca cero. */
  costCoveragePct: number | null;
  warnings: string[];
}

export interface AnalysisContext {
  timezone: string;
  currency: string | null;
  /** Primer día local de la ventana (yyyy-MM-dd). */
  startDay: string;
  /** Último día local de la ventana. */
  endDay: string;
  /** Hora local de corte (HH:MM) cuando la ventana es parcial; null en periodos cerrados. */
  cutoffLocal: string | null;
  comparison: string;
  branch: string | null;
}

export interface AnalysisResponse<M, B> {
  intent: IntentId;
  context: AnalysisContext;
  quality: AnalysisQuality;
  metrics: M;
  breakdowns: B;
  insights: Insight[];
  /** Solo `increase_tomorrow_sales` recomienda; los análisis descriptivos devuelven []. */
  recommendations: Recommendation[];
  /** Texto determinista con las cifras ya calculadas. El modelo lo reformula sin cambiar ninguna cifra. */
  summary: string;
}

/** Ventas de una franja de media hora local y una sucursal (un valor de ticket colapsado: no se cuenta dos veces). */
export interface SalesSlotRow {
  /** Fecha local yyyy-MM-dd. */
  day: string;
  /** Franja de media hora del día local: 0 = 00:00-00:29, 1 = 00:30-00:59 … 47 = 23:30-23:59. */
  slot: number;
  agentId: string;
  sales: number;
  tickets: number;
}

export interface ProductRow {
  description: string;
  period: "current" | "previous";
  revenue: number;
  units: number;
}

/** Sucursal para las ventas sin agente asignado (capturas anteriores al campo o con la api-key legacy). */
export const UNASSIGNED_AGENT = "unassigned";
export const UNASSIGNED_LABEL = "Sin sucursal asignada";
