import type { DocumentType, ParsedItem } from "../parsing/types.js";

/**
 * `needs_review` es el destino de todo lo resuelto por el fallback de
 * Bedrock, aunque haya pasado el chequeo de coherencia económica — un LLM
 * puede alucinar de forma internamente consistente (números que cierran
 * entre sí pero no reflejan el ticket real), así que no se trata como
 * `parsed` hasta que un humano lo confirme. `discarded` es lo que elige el
 * dueño del negocio cuando revisa un `needs_review` y no era una venta real
 * (ver `review/handler.ts`, el único lugar que hace esa transición).
 */
export type TicketStatus = "pending" | "parsed" | "needs_review" | "failed" | "discarded";

export interface OnboardingState {
  version: 1;
  startedAt?: string;
  lastDeferredAt?: string;
  completedAt?: string;
  productTourCompletedAt?: string;
  starterDashboardCreatedAt?: string;
}

export interface TenantRecord {
  tenantId: string;
  businessName: string;
  /**
   * `"provisioning"` mientras `POST /signup` no terminó de crear todo (usuario,
   * negocio y los 5 códigos); se borra al final. Permite que un reintento con el
   * mismo email reanude un registro interrumpido. Ausente = completo (también
   * los negocios dados de alta antes de este campo o con `onboard-tenant.ts`).
   */
  signupState?: "provisioning";
  /** Parser a usar cuando el puerto de origen no tiene una asignación puntual en `portParsers`. */
  parserId: string;
  /**
   * Un negocio puede tener varios periféricos distintos emitiendo formatos
   * distintos por el mismo agente (ej. impresora en COM3 + datáfono en
   * COM7) — acá se resuelve el parser por puerto. Si un puerto no aparece
   * acá, se usa `parserId` como default.
   */
  portParsers?: Record<string, string>;
  /**
   * Api-key compartida del tenant (`onboard-tenant.ts`) — legacy, solo la
   * sigue aceptando `ingest` como fallback para agentes que todavía no se
   * activaron por código (ver sección 9.3/9.4 de PROYECTO.md). Un tenant
   * dado de alta por `POST /signup` no tiene una: todos sus agentes se
   * activan por código desde el vamos, así que nunca hace falta.
   */
  apiKeyId?: string;
  createdAt: string;
  /**
   * Ausente o "active" = normal. "blocked" corta el login del dashboard
   * (Cognito Pre-Authentication trigger, `tenants/preAuthHandler.ts`), cada
   * petición humana autenticada (`shared/auth.ts`) y la subida de tickets del agente
   * (`ingest/handler.ts`) — bloquear en un solo lugar no alcanza, un tenant
   * bloqueado no debería poder seguir mandando datos aunque no pueda ver el
   * dashboard. Se cambia con `scripts/set-tenant-status.ts`.
   */
  status?: "active" | "blocked";
  /**
   * Solo existe en tenants creados desde que se incorporó el onboarding.
   * Su ausencia identifica a tenants anteriores, que no deben ser enviados
   * de forma retroactiva por el recorrido inicial.
   */
  onboarding?: OnboardingState;
}

export interface TicketRecord {
  tenantId: string;
  ticketId: string;
  port: string;
  /**
   * Agente (PC) que subió el ticket — resuelto por api-key en `ingest/handler.ts`.
   * Ausente para tickets subidos con la api-key compartida legacy del tenant
   * (nunca se activaron por código, no hay `AgentRecord` que resolver) o
   * capturados antes de que este campo existiera.
   */
  agentId?: string;
  capturedAt: string;
  status: TicketStatus;
  rawS3Key: string;
  /**
   * Formato del artefacto crudo en S3. Ausente = `"text"` (tickets subidos
   * antes de que existiera este campo, y toda la captura serie/TCP).
   * `"escpos"` = bytes ESC/POS crudos, que pueden ser texto o una imagen
   * raster — el parser decide y, si es imagen, le hace OCR. `"ubl"` = XML de
   * una factura electrónica de la DIAN (ver `parsing/ubl.ts`).
   */
  rawKind?: "text" | "escpos" | "ubl";
  /** Solo facturas electrónicas: el número de la factura, ej. "FVA38267". */
  documentNumber?: string;
  /** Ver `DocumentType`. Ausente = `"sale"`. */
  docType?: DocumentType;
  /** Solo facturas electrónicas — ver `ParsedTicket`. */
  customerName?: string;
  customerId?: string;
  purchaseOrder?: string;
  /** `YYYY-MM-DD`. */
  paymentDueDate?: string;
  parsedAt?: string;
  items?: ParsedItem[];
  total?: number;
  tax?: number;
  discount?: number;
  tip?: number;
  failReason?: string;
  /**
   * Quién extrajo `items`/`total`: el parser determinístico del tenant, o
   * el fallback de Bedrock cuando ese parser no reconoció el formato. Un
   * LLM puede alucinar montos — este campo permite auditar/filtrar los
   * tickets resueltos por ese camino en vez de confiar en todos por igual.
   */
  parsedBy?: "deterministic" | "bedrock-fallback" | "bedrock-vision";
  /**
   * Auditoría de la revisión humana (`review/handler.ts`): quién confirmó o
   * descartó el ticket, cuándo y qué decidió. Se escriben en el mismo
   * UpdateItem que cambia `status`, así que nunca hay una decisión sin autor ni
   * un autor sin decisión. `reviewedBy` es el email del usuario de Cognito (o su
   * `sub` si el token no lo trae). Ausentes en tickets que nadie revisó. Un
   * reproceso posterior del ticket no los borra: miran la última revisión humana.
   */
  reviewedBy?: string;
  reviewedAt?: string;
  reviewDecision?: "confirmed" | "discarded";
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
  /** Ver `TicketRecord.agentId`. */
  agentId?: string;
  /** Ver `TicketRecord.rawKind`. Ausente = `"text"`. */
  rawKind?: "text" | "escpos" | "ubl";
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
  version?: string;
  location?: {
    label?: string;
    city?: string;
    lat?: number;
    lng?: number;
  };
}

/**
 * Pedido de diagnóstico para un agente. Lo crea el operador (consola local,
 * directo en DynamoDB); el agente lo recibe en la respuesta de su heartbeat,
 * corre el script de su catálogo local que corresponde a `scriptId` (nunca
 * texto libre) y devuelve la salida. Un `delivered` que no se resuelve = el
 * agente cayó a mitad de camino.
 */
export type AgentCommandStatus = "pending" | "delivered" | "done" | "failed";

export interface AgentCommandRecord {
  tenantId: string;
  agentId: string;
  commandId: string;
  scriptId: string;
  status: AgentCommandStatus;
  createdAt: string;
  deliveredAt?: string;
  completedAt?: string;
  exitCode?: number;
  durationMs?: number;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  /** Epoch en segundos — TTL de la tabla Agents. */
  ttl?: number;
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
  /** `activating`: canje en curso o interrumpido (con `agentId` ya reservado); ver `agents/activateHandler.ts`. */
  status: "unused" | "activating" | "used";
  createdAt: string;
  usedAt?: string;
  agentId?: string;
  /** Epoch ms hasta el que una activación en curso es exclusiva; vencido, un reintento puede reanudarla. */
  activatingUntil?: number;
}

export type WidgetVisualization = "kpi" | "bar" | "line" | "donut";
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
  /**
   * Solo ítems cuya descripción contiene este texto (sin distinguir
   * mayúsculas). Hoy lo usa únicamente el asistente ("lo que diga
   * horneadas") — `widgets/createHandler.ts` no lo acepta todavía.
   */
  descriptionContains?: string;
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
