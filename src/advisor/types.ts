// Advisor: el "directivo" digital del negocio; de cara al usuario se llama Innova. El nombre de
// marca vive solo en el frontend: acá el módulo se llama `advisor` para que un cambio de marca
// no toque el código, las rutas ni los datos. Los detectores (funciones puras sobre los datos)
// generan asuntos; la IA solo los redacta, nunca calcula las cifras.

export const MATTER_DETECTORS = ["sales_anomaly", "agent_offline", "capture_zero", "review_backlog", "data_integrity"] as const;
export type MatterDetector = (typeof MATTER_DETECTORS)[number];

export type MatterSeverity = "info" | "warn" | "critical";

/** `new` → el dueño todavía no lo vio; `resolved` lo marca el propio sistema cuando la condición desapareció. */
export type MatterStatus = "new" | "seen" | "dismissed" | "resolved";

export const MATTER_RETENTION_DAYS = 90;

/** Hora local a la que sale el briefing diario (y corren los detectores que usan Athena). */
export const DEFAULT_BRIEFING_HOUR = 7;

/**
 * Preferencias de Advisor dentro del tenant. `timeZone` es IANA ("America/Bogota"): hasta
 * ahora la zona horaria solo la mandaba el navegador, pero el job corre sin navegador y
 * necesita saber cuándo son las 07:00 de cada negocio.
 */
export interface AdvisorSettings {
  timeZone?: string;
  /** 0-23, hora local del briefing. Ausente = `DEFAULT_BRIEFING_HOUR`. */
  briefingHour?: number;
  /** Destinatarios de los avisos por correo; se editan desde la interfaz. */
  notifyEmails?: string[];
  /**
   * Interruptor de la beta: con `true` el dashboard de este negocio muestra la vista nueva del
   * asistente (Innova). Ausente = apagado. Se cambia con `scripts/set-tenant-advisor-view.ts`.
   */
  betaView?: boolean;
}

export interface MatterRecord {
  tenantId: string;
  detector: MatterDetector;
  /** "total", o "branch:<agentId>" para una sucursal. No puede contener "#" (separador de la clave). */
  scope: string;
  /** Fecha local (YYYY-MM-DD) a la que se refiere el asunto. */
  periodDate: string;
  severity: MatterSeverity;
  status: MatterStatus;
  /** Valor esperado según el historial y el real, cuando el detector es numérico. */
  expected?: number;
  actual?: number;
  /** Los números crudos que respaldan el asunto: el texto que redacte la IA solo puede citar estos. */
  evidence: Record<string, string | number | null>;
  createdAt: string;
  updatedAt: string;
  seenAt?: string;
  resolvedAt?: string;
}

export interface MatterItem extends MatterRecord {
  pk: string;
  sk: string;
  /** Epoch en segundos: atributo TTL de DynamoDB. */
  ttl: number;
}

/** Lo que produce un detector; el ciclo de vida (estado, fechas, TTL) lo agrega la capa que lo guarda. */
export type MatterCandidate = Pick<MatterRecord, "detector" | "scope" | "periodDate" | "severity" | "expected" | "actual" | "evidence">;

/**
 * Cuándo suele capturar tickets un robot, por hora local (índice 0-23), sobre sus últimos
 * días con actividad. Se calcula una vez al día con Athena y se guarda, para que los
 * chequeos de cada hora (robot caído, captura en cero) no necesiten Athena.
 */
export interface AgentHabit {
  /** Días con al menos un ticket que sustentan el hábito. */
  activeDays: number;
  /** Fracción de esos días con tickets en cada hora. */
  dayShare: number[];
  /** Tickets promedio en cada hora, por día activo. */
  avgTickets: number[];
}

export function isValidMatterScope(scope: string): boolean {
  return scope.length > 0 && scope.length <= 80 && !scope.includes("#");
}
