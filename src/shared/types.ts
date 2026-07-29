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
