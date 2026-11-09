import type { OpeningHoursDay, TenantProfile } from "../shared/types.js";

const CURRENCY_RE = /^[A-Z]{3}$/;
const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS = ["1", "2", "3", "4", "5", "6", "7"] as const;
const INDUSTRY_MAX = 40;
const LOCALE_MAX = 12;

export type ProfileValidation = { ok: true; profile: TenantProfile } | { ok: false; error: string };

function parseDayHours(raw: unknown, path: string): { ok: true; value: OpeningHoursDay } | { ok: false; error: string } {
  if (raw === "closed") return { ok: true, value: "closed" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `${path} inválido: se esperaba { open, close } o "closed"` };
  }
  const day = raw as Record<string, unknown>;
  if (typeof day.open !== "string" || !TIME_RE.test(day.open)) {
    return { ok: false, error: `${path}.open inválido (HH:MM 24h)` };
  }
  if (typeof day.close !== "string" || !TIME_RE.test(day.close)) {
    return { ok: false, error: `${path}.close inválido (HH:MM 24h)` };
  }
  return { ok: true, value: { open: day.open, close: day.close } };
}

/**
 * Valida el body de PATCH /me/profile. Campos omitidos no se tocan (merge en el
 * handler). `null` en un campo borra ese campo. No inventa defaults.
 */
export function parseProfilePatch(body: unknown): ProfileValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "se esperaba un objeto JSON" };
  }
  const raw = body as Record<string, unknown>;
  const profile: TenantProfile = {};
  let touched = false;

  if ("currency" in raw) {
    touched = true;
    if (raw.currency === null) {
      // borrado — se maneja en merge
    } else if (typeof raw.currency !== "string" || !CURRENCY_RE.test(raw.currency.trim().toUpperCase())) {
      return { ok: false, error: 'currency inválida (código ISO 4217 de 3 letras, ej. "COP")' };
    } else {
      profile.currency = raw.currency.trim().toUpperCase();
    }
  }

  if ("locale" in raw) {
    touched = true;
    if (raw.locale === null) {
      // borrado
    } else if (typeof raw.locale !== "string" || raw.locale.trim().length === 0 || raw.locale.trim().length > LOCALE_MAX) {
      return { ok: false, error: 'locale inválido (ej. "es-CO")' };
    } else {
      const normalized = raw.locale.trim().replace(/-([a-z]{2})$/i, (_, cc: string) => `-${cc.toUpperCase()}`).replace(/^([A-Z]{2})/, (m) => m.toLowerCase());
      if (!LOCALE_RE.test(normalized)) return { ok: false, error: 'locale inválido (ej. "es-CO")' };
      profile.locale = normalized;
    }
  }

  if ("industry" in raw) {
    touched = true;
    if (raw.industry === null) {
      // borrado
    } else if (typeof raw.industry !== "string" || raw.industry.trim().length === 0 || raw.industry.trim().length > INDUSTRY_MAX) {
      return { ok: false, error: `industry inválido (texto 1–${INDUSTRY_MAX} caracteres)` };
    } else {
      profile.industry = raw.industry.trim();
    }
  }

  if ("openingHours" in raw) {
    touched = true;
    if (raw.openingHours === null) {
      // borrado
    } else if (!raw.openingHours || typeof raw.openingHours !== "object" || Array.isArray(raw.openingHours)) {
      return { ok: false, error: "openingHours inválido" };
    } else {
      const oh = raw.openingHours as Record<string, unknown>;
      const openingHours: NonNullable<TenantProfile["openingHours"]> = {};
      if ("default" in oh) {
        if (oh.default === null) {
          // sin default
        } else {
          const parsed = parseDayHours(oh.default, "openingHours.default");
          if (!parsed.ok) return parsed;
          if (parsed.value === "closed") return { ok: false, error: 'openingHours.default no admite "closed"' };
          openingHours.default = parsed.value;
        }
      }
      if ("byWeekday" in oh) {
        if (oh.byWeekday === null) {
          // sin byWeekday
        } else if (!oh.byWeekday || typeof oh.byWeekday !== "object" || Array.isArray(oh.byWeekday)) {
          return { ok: false, error: "openingHours.byWeekday inválido" };
        } else {
          const byWeekday: NonNullable<NonNullable<TenantProfile["openingHours"]>["byWeekday"]> = {};
          for (const [key, value] of Object.entries(oh.byWeekday as Record<string, unknown>)) {
            if (!(WEEKDAYS as readonly string[]).includes(key)) {
              return { ok: false, error: `openingHours.byWeekday clave inválida "${key}" (1=lunes … 7=domingo)` };
            }
            if (value === null) continue;
            const parsed = parseDayHours(value, `openingHours.byWeekday.${key}`);
            if (!parsed.ok) return parsed;
            byWeekday[key as (typeof WEEKDAYS)[number]] = parsed.value;
          }
          if (Object.keys(byWeekday).length > 0) openingHours.byWeekday = byWeekday;
        }
      }
      if (openingHours.default || openingHours.byWeekday) {
        profile.openingHours = openingHours;
      } else {
        // Objeto vacío = borrar horarios (mismo efecto que null).
        // El clear lo completa `profileClears` vía sentinel en el handler.
      }
    }
  }

  if (!touched) return { ok: false, error: "nada que actualizar (currency, locale, industry u openingHours)" };
  return { ok: true, profile };
}

/**
 * Aplica un patch parcial sobre la ficha actual. `null` en el body original
 * se interpreta vía `clears`: campos presentes en `patch` reemplazan; campos
 * marcados en `clears` se borran.
 */
export function mergeProfile(
  current: TenantProfile | undefined,
  patch: TenantProfile,
  clears: ReadonlySet<keyof TenantProfile>,
): TenantProfile | undefined {
  const next: TenantProfile = { ...(current ?? {}) };
  if ("currency" in patch) next.currency = patch.currency;
  if (clears.has("currency")) delete next.currency;
  if ("locale" in patch) next.locale = patch.locale;
  if (clears.has("locale")) delete next.locale;
  if ("industry" in patch) next.industry = patch.industry;
  if (clears.has("industry")) delete next.industry;
  if ("openingHours" in patch) next.openingHours = patch.openingHours;
  if (clears.has("openingHours")) delete next.openingHours;

  if (!next.currency && !next.locale && !next.industry && !next.openingHours) return undefined;
  return next;
}

/** Campos a borrar según el body crudo (`null` explícito). */
export function profileClears(body: unknown): Set<keyof TenantProfile> {
  const clears = new Set<keyof TenantProfile>();
  if (!body || typeof body !== "object" || Array.isArray(body)) return clears;
  const raw = body as Record<string, unknown>;
  for (const key of ["currency", "locale", "industry", "openingHours"] as const) {
    if (key in raw && raw[key] === null) clears.add(key);
  }
  return clears;
}

/** Vista pública segura para GET /me (sin campos internos). */
export function toPublicProfile(profile: TenantProfile | undefined): TenantProfile | null {
  if (!profile) return null;
  const out: TenantProfile = {};
  if (profile.currency) out.currency = profile.currency;
  if (profile.locale) out.locale = profile.locale;
  if (profile.industry) out.industry = profile.industry;
  if (profile.openingHours) out.openingHours = profile.openingHours;
  return Object.keys(out).length ? out : null;
}
