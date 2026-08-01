import type { ParsedItem } from "../parsing/types.js";

/**
 * `needs_review` es el destino de todo lo resuelto por el fallback de
 * Bedrock, aunque haya pasado el chequeo de coherencia económica — un LLM
 * puede alucinar de forma internamente consistente (números que cierran
 * entre sí pero no reflejan el ticket real), así que no se trata como
 * `parsed` hasta medir precisión real contra tickets de verdad. El
 * mecanismo para promover de `needs_review` a `parsed` (o rechazar) queda
 * pendiente — no existe todavía.
 */
export type TicketStatus = "pending" | "parsed" | "needs_review" | "failed";

export interface TenantRecord {
  tenantId: string;
  businessName: string;
  /** Parser a usar cuando el puerto de origen no tiene una asignación puntual en `portParsers`. */
  parserId: string;
  /**
   * Un negocio puede tener varios periféricos distintos emitiendo formatos
   * distintos por el mismo agente (ej. impresora en COM3 + datáfono en
   * COM7) — acá se resuelve el parser por puerto. Si un puerto no aparece
   * acá, se usa `parserId` como default.
   */
  portParsers?: Record<string, string>;
  apiKeyId: string;
  createdAt: string;
}

export interface TicketRecord {
  tenantId: string;
  ticketId: string;
  port: string;
  capturedAt: string;
  status: TicketStatus;
  rawS3Key: string;
  parsedAt?: string;
  items?: ParsedItem[];
  total?: number;
  discount?: number;
  tip?: number;
  failReason?: string;
  /**
   * Quién extrajo `items`/`total`: el parser determinístico del tenant, o
   * el fallback de Bedrock cuando ese parser no reconoció el formato. Un
   * LLM puede alucinar montos — este campo permite auditar/filtrar los
   * tickets resueltos por ese camino en vez de confiar en todos por igual.
   */
  parsedBy?: "deterministic" | "bedrock-fallback";
}

/**
 * Mensaje que viaja por SQS entre el Lambda de ingest y el de parseo.
 * Lleva todo lo necesario para reconstruir la clave del ticket sin tener
 * que hacer una lectura extra a DynamoDB antes de poder actualizarlo.
 */
export interface ParseJobMessage {
  tenantId: string;
  ticketId: string;
  capturedAt: string;
  rawS3Key: string;
  /** Puerto/periférico de origen — determina qué parser usar (ver TenantRecord.portParsers). */
  port: string;
}

/**
 * Un robot (instancia de `print-capture-agent` corriendo en la PC de un
 * negocio) activado vía un código de `ActivationCodeRecord`. A diferencia
 * de la api-key compartida del tenant (pensada para el onboarding manual
 * original), cada agente tiene su propia api-key — así se puede identificar,
 * nombrar y revocar un robot puntual sin afectar al resto del negocio.
 */
export interface AgentRecord {
  tenantId: string;
  agentId: string;
  name: string;
  apiKeyId: string;
  createdAt: string;
  lastSeenAt?: string;
}

/**
 * Código de un solo uso para vincular un robot nuevo a un tenant. Se
 * generan de a 5 por tenant al darlo de alta (ver `onboard-tenant.ts`) —
 * el tope de 5 robots es estructural: no hay endpoint para generar más
 * códigos, así que no hay un sexto que canjear. Sin expiración a propósito
 * (decisión explícita): el vencimiento no aporta nada acá porque el código
 * ya queda inutilizable apenas se usa una vez.
 */
export interface ActivationCodeRecord {
  tenantId: string;
  code: string;
  status: "unused" | "used";
  createdAt: string;
  usedAt?: string;
  agentId?: string;
}

export type WidgetVisualization = "kpi" | "bar" | "donut";
export type WidgetAggregation = "sum" | "avg" | "max" | "min" | "count";

export interface WidgetMetric {
  /** Un campo numérico de `widgets/fields.ts`, o el pseudo-campo "event_count". */
  field: string;
  aggregation: WidgetAggregation;
}

export interface WidgetFilters {
  dateFrom?: string;
  dateTo?: string;
  port?: string;
  status?: string;
}

/**
 * Widget configurado por el usuario para su dashboard — es config, no
 * datos, por eso vive en DynamoDB junto a Tenants en vez de en la capa
 * analítica (S3/Athena). `metric.field`/`groupBy` se validan contra la
 * lista blanca de `widgets/fields.ts` antes de guardarse, y de nuevo antes
 * de generar SQL — nunca se confía en un campo guardado sin revalidar.
 */
export interface WidgetRecord {
  tenantId: string;
  widgetId: string;
  name: string;
  visualization: WidgetVisualization;
  metric: WidgetMetric;
  /** Campo categórico para agrupar (bar/donut) — ausente para un KPI simple. */
  groupBy?: string;
  filters?: WidgetFilters;
  createdAt: string;
}
