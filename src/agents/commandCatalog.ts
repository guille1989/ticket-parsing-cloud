import { randomBytes } from "node:crypto";

/**
 * Catálogo de diagnósticos que el operador le puede pedir a un agente. El
 * pedido lleva solo el `scriptId` — el PowerShell vive dentro del agente
 * instalado (`print-capture-agent/src/diagnostics/catalog.ts`) y nunca viaja
 * por la red, así que ni la API ni la tabla pueden hacer correr texto
 * arbitrario en la PC del negocio. Todos los scripts son de solo lectura.
 *
 * Mantener los ids alineados con el catálogo del agente; un id que el agente
 * no conoce vuelve como `failed`, no se ejecuta nada.
 */
export const DIAGNOSTIC_SCRIPTS = {
  "agent-health": "Estado general: servicio, versión de Windows, uptime y disco",
  printers: "Impresoras instaladas, puertos y trabajos en cola",
  spooler: "Servicio de spooler, carpeta de spool y errores recientes de impresión",
  network: "Conectividad hacia la nube de InnoApp (DNS, TCP 443, proxy)",
  "agent-logs": "Últimas líneas de los logs del agente y del servicio",
  "agent-state": "Cola local de tickets y estado reportado por el agente",
} as const;

export type DiagnosticScriptId = keyof typeof DIAGNOSTIC_SCRIPTS;

export function isDiagnosticScriptId(value: unknown): value is DiagnosticScriptId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(DIAGNOSTIC_SCRIPTS, value);
}

/** Epoch en ms con relleno (ordena por fecha) + sufijo aleatorio. Seguro en un path de URL. */
export function newCommandId(now = Date.now()): string {
  return `${String(now).padStart(13, "0")}-${randomBytes(3).toString("hex")}`;
}

export const COMMAND_ID_PATTERN = /^\d{13}-[0-9a-f]{6}$/;

/** Los comandos se borran solos (TTL de la tabla) pasado este tiempo. */
export const COMMAND_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Tope por campo de salida; DynamoDB limita el item a 400 KB. */
export const MAX_OUTPUT_CHARS = 60_000;

/** Un agente que estuvo caído no recibe de golpe un diagnóstico viejo: se descartan los de más de esto. */
export const COMMAND_MAX_AGE_MS = 15 * 60 * 1000;
