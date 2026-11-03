import { isValidTimeZone } from "../widgets/fields.js";
import { buildAgentHabits, runDailyDetectors, runHourlyDetectors } from "./detectors/index.js";
import { loadHabitProfile, saveHabitProfile, type HabitProfile } from "./habitStore.js";
import { localDate, localHour } from "./localTime.js";
import { resolveClearedMatters, upsertMatters, type UpsertResult } from "./matterStore.js";
import { loadAgents, loadRecentTickets, loadReviewQueue, type AdvisorTenant } from "./opsData.js";
import { loadSalesHistory } from "./salesHistory.js";
import { DEFAULT_BRIEFING_HOUR, type MatterCandidate, type MatterDetector } from "./types.js";

/** Los tenants no guardaban zona horaria; mientras no la tengan, todos los negocios actuales están en Colombia. */
export const DEFAULT_TIME_ZONE = "America/Bogota";

const HOUR_MS = 3_600_000;
// Ventana de tickets recientes para "captura en cero" (3 h) y la tasa de fallos (el resto).
const RECENT_WINDOW_HOURS = 24;

/** Dependencias inyectables: los tests las reemplazan, el Lambda usa las reales. */
export interface AdvisorDeps {
  loadSalesHistory: typeof loadSalesHistory;
  loadAgents: typeof loadAgents;
  loadRecentTickets: typeof loadRecentTickets;
  loadReviewQueue: typeof loadReviewQueue;
  loadHabitProfile: typeof loadHabitProfile;
  saveHabitProfile: typeof saveHabitProfile;
  upsertMatters: typeof upsertMatters;
  resolveClearedMatters: typeof resolveClearedMatters;
}

export const realDeps: AdvisorDeps = {
  loadSalesHistory,
  loadAgents,
  loadRecentTickets,
  loadReviewQueue,
  loadHabitProfile,
  saveHabitProfile,
  upsertMatters,
  resolveClearedMatters,
};

export interface RunOptions {
  /** Calcula todo pero no escribe asuntos (el perfil de hábitos sí se guarda, para no repetir Athena cada hora). */
  dryRun?: boolean;
  /** Corre el análisis diario aunque no sea la hora o ya se haya hecho hoy. */
  forceDaily?: boolean;
}

export interface TenantRunResult {
  tenantId: string;
  businessName: string;
  timeZone: string;
  ranDaily: boolean;
  ranHourly: boolean;
  dryRun: boolean;
  candidates: MatterCandidate[];
  created: number;
  updated: number;
  reopened: number;
  resolved: number;
  errors: string[];
}

export function resolveSettings(tenant: Pick<AdvisorTenant, "advisor">): { timeZone: string; briefingHour: number } {
  const zone = tenant.advisor?.timeZone;
  const hour = tenant.advisor?.briefingHour;
  return {
    timeZone: zone && isValidTimeZone(zone) ? zone : DEFAULT_TIME_ZONE,
    briefingHour: Number.isInteger(hour) && hour! >= 0 && hour! <= 23 ? hour! : DEFAULT_BRIEFING_HOUR,
  };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Una pasada de Advisor para un negocio (el Lambda la corre cada hora):
 *  - Análisis diario, una vez al día a partir de la hora del briefing: una consulta Athena con
 *    el historial → hábitos de cada robot (se guardan) + detectores de venta. Si Athena falla,
 *    se reintenta en la hora siguiente; un marcador `dailyDate` evita repetirlo si salió bien.
 *  - Chequeos de cada hora: solo DynamoDB (robot caído, captura en cero, cola, tickets fallidos).
 * Un fallo en una parte no tumba las demás, y solo se resuelven los asuntos de los detectores
 * que de verdad corrieron.
 */
export async function runTenant(
  tenant: AdvisorTenant,
  now: Date,
  options: RunOptions = {},
  deps: AdvisorDeps = realDeps,
): Promise<TenantRunResult> {
  const { timeZone, briefingHour } = resolveSettings(tenant);
  const today = localDate(now, timeZone);
  const result: TenantRunResult = {
    tenantId: tenant.tenantId,
    businessName: tenant.businessName,
    timeZone,
    ranDaily: false,
    ranHourly: false,
    dryRun: options.dryRun === true,
    candidates: [],
    created: 0,
    updated: 0,
    reopened: 0,
    resolved: 0,
    errors: [],
  };

  let profile: HabitProfile | undefined;
  try {
    profile = await deps.loadHabitProfile(tenant.tenantId);
  } catch (err) {
    result.errors.push(`perfil de hábitos: ${message(err)}`);
  }

  let newProfile: HabitProfile | undefined;
  const dailyDue = options.forceDaily === true || (localHour(now, timeZone) >= briefingHour && profile?.dailyDate !== today);
  if (dailyDue) {
    try {
      const history = await deps.loadSalesHistory(tenant.tenantId, timeZone, now);
      newProfile = { habits: buildAgentHabits(history, now, timeZone), computedAt: now.toISOString(), dailyDate: today };
      result.candidates.push(...runDailyDetectors({ now, timeZone, history }));
      result.ranDaily = true;
    } catch (err) {
      result.errors.push(`análisis diario: ${message(err)}`);
    }
  }

  const habits = (newProfile ?? profile)?.habits ?? {};
  try {
    const since = new Date(now.getTime() - RECENT_WINDOW_HOURS * HOUR_MS).toISOString();
    const [agents, recentTickets, reviewQueue] = await Promise.all([
      deps.loadAgents(tenant.tenantId),
      deps.loadRecentTickets(tenant.tenantId, since),
      deps.loadReviewQueue(tenant.tenantId),
    ]);
    result.candidates.push(
      ...runHourlyDetectors({ now, timeZone, agents, habits, recentTickets, recentWindowHours: RECENT_WINDOW_HOURS, reviewQueue }),
    );
    result.ranHourly = true;
  } catch (err) {
    result.errors.push(`chequeos horarios: ${message(err)}`);
  }

  if (!options.dryRun) {
    try {
      const saved: UpsertResult[] = await deps.upsertMatters(tenant.tenantId, result.candidates, now);
      for (const { change } of saved) result[change]++;
      if (result.ranHourly) {
        // Sin hábitos, "robot caído" y "captura en cero" no pudieron evaluar nada: no cuentan como ejecutados.
        const ran: MatterDetector[] = ["review_backlog", "data_integrity"];
        if (Object.keys(habits).length > 0) ran.push("agent_offline", "capture_zero");
        result.resolved = await deps.resolveClearedMatters(tenant.tenantId, today, ran, new Set(saved.map(({ item }) => item.sk)), now);
      }
    } catch (err) {
      result.errors.push(`guardado de asuntos: ${message(err)}`);
      return result; // sin guardar el marcador diario: la próxima hora reintenta todo
    }
  }

  if (newProfile) {
    try {
      await deps.saveHabitProfile(tenant.tenantId, newProfile, now);
    } catch (err) {
      result.errors.push(`guardado del perfil de hábitos: ${message(err)}`);
    }
  }
  return result;
}
