import type { AgentRecord } from "../../shared/types.js";
import type { RecentTicket, ReviewQueueSummary } from "../opsData.js";
import type { SalesHourRow } from "../salesHistory.js";
import type { AgentHabit } from "../types.js";

/** Entrada de los detectores que usan el historial de Athena (corren una vez al día, a la hora del briefing). */
export interface DailyContext {
  now: Date;
  /** Zona IANA del negocio: define qué es "ayer" y a qué hora corresponde cada venta. */
  timeZone: string;
  history: SalesHourRow[];
}

/** Entrada de los chequeos baratos que corren cada hora: solo DynamoDB y el hábito guardado. */
export interface HourlyContext {
  now: Date;
  timeZone: string;
  agents: AgentRecord[];
  /** Por agentId; un robot sin hábito (poco historial) no se evalúa. */
  habits: Record<string, AgentHabit>;
  /** Tickets capturados en las últimas `recentWindowHours` horas (al menos 4 para "captura en cero"). */
  recentTickets: RecentTicket[];
  recentWindowHours: number;
  reviewQueue: ReviewQueueSummary;
}
