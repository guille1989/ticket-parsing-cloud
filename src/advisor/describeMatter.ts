import type { MatterItem } from "./types.js";

/**
 * Texto de un asunto, redactado una sola vez en el backend para que lo compartan la pantalla, la
 * voz de Innova y, más adelante, el correo. Son plantillas fijas con las cifras que ya calculó el
 * detector (`evidence`): no interviene ninguna IA, así que no puede inventar un número.
 *
 * `spoken` es lo que se lee en voz alta: sin símbolos raros y de una sola tirada.
 */
export interface MatterText {
  title: string;
  detail: string;
  spoken: string;
}

type DescribableMatter = Pick<MatterItem, "detector" | "scope" | "periodDate" | "expected" | "actual" | "evidence">;

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** Montos sin símbolo de moneda y con punto de miles, igual que el dashboard (`fmtAmount`): todavía no hay moneda por negocio. */
function amount(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function number(evidence: MatterItem["evidence"], key: string): number | null {
  const value = evidence[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(evidence: MatterItem["evidence"], key: string): string | null {
  const value = evidence[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "45 minutos", "3 horas", "2 días": aproximado a propósito, nadie necesita los minutos exactos. */
export function duration(minutes: number): string {
  if (minutes < 90) return plural(Math.max(1, Math.round(minutes)), "minuto", "minutos");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return plural(hours, "hora", "horas");
  return plural(Math.round(hours / 24), "día", "días");
}

function weekdayOf(periodDate: string): string {
  return WEEKDAYS[new Date(`${periodDate}T00:00:00Z`).getUTCDay()];
}

function result(title: string, detail: string): MatterText {
  return { title, detail, spoken: detail ? `${title}. ${detail}` : `${title}.` };
}

export function describeMatter(matter: DescribableMatter, branchLabel: string | null): MatterText {
  const { evidence } = matter;
  const branch = branchLabel ?? text(evidence, "agentName") ?? "Una sucursal";

  switch (matter.detector) {
    case "agent_offline": {
      const minutes = number(evidence, "minutesSinceSeen");
      return result(
        minutes === null ? `${branch} no ha reportado señal` : `${branch} lleva ${duration(minutes)} sin conectarse`,
        "A esta hora normalmente está capturando ventas. Revisa que el equipo esté encendido y con internet.",
      );
    }

    case "capture_zero": {
      const hours = number(evidence, "windowHours") ?? 3;
      const expected = matter.expected !== undefined ? Math.round(matter.expected) : null;
      return result(
        `${branch} está conectada pero no captura ventas`,
        `En las últimas ${hours} horas ${expected ? `se esperaban unos ${expected} tickets y` : "normalmente entran tickets y"} no entró ninguno. Puede ser la impresora o el POS.`,
      );
    }

    case "review_backlog": {
      const count = matter.actual ?? number(evidence, "pendingTickets") ?? 0;
      const ageHours = number(evidence, "oldestAgeHours");
      const where = "Puedes confirmarlos o descartarlos en la vista de Agentes.";
      return result(
        count === 1 ? "1 ticket espera tu revisión" : `${count} tickets esperan tu revisión`,
        ageHours !== null && ageHours >= 24 ? `El más antiguo lleva ${duration(ageHours * 60)} sin revisar. ${where}` : where,
      );
    }

    case "data_integrity": {
      const rate = number(evidence, "failureRatePct");
      const failed = number(evidence, "failedTickets");
      const total = number(evidence, "totalTickets");
      const hours = number(evidence, "windowHours") ?? 24;
      return result(
        rate === null ? "Varios tickets recientes no se pudieron leer" : `${String(Math.round(rate))} % de los tickets recientes no se pudo leer`,
        failed !== null && total !== null
          ? `${failed} de ${total} tickets de las últimas ${hours} horas fallaron al procesarse. Puede que el POS haya cambiado su formato.`
          : "Puede que el POS haya cambiado su formato.",
      );
    }

    case "sales_anomaly": {
      const subject = matter.scope === "total" ? "El negocio" : branch;
      const day = weekdayOf(matter.periodDate);
      const pct = Math.round(Math.abs(number(evidence, "deltaPct") ?? 0));
      const spike = evidence.direction === "spike";
      const actual = matter.actual ?? 0;
      const expected = matter.expected ?? 0;
      if (!spike && actual === 0) {
        return result(`${subject} no registró ventas el ${day}`, `Un ${day} normal vende unos ${amount(expected)}.`);
      }
      return result(
        `${subject} vendió un ${pct} % ${spike ? "más" : "menos"} de lo habitual el ${day}`,
        `Vendió ${amount(actual)} frente a unos ${amount(expected)} de un ${day} normal.`,
      );
    }

    default:
      return result(String(matter.detector), "");
  }
}
