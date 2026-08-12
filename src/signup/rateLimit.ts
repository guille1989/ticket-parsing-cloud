import { SIGNUP_USAGE_TABLE } from "../shared/dynamo.js";
import { incrementWithCap } from "../shared/rateLimit.js";

// `POST /signup` es público (sin api-key, sin Cognito — la persona todavía
// no tiene ninguna credencial) y crea recursos reales (usuario Cognito,
// tenant, 5 códigos de activación) — sin esto, un bot o un bug podría
// generar tenants sin límite. Una sola ventana por IP alcanza acá: no es
// antifraude serio, solo frena un loop obvio (misma lógica que el rate
// limit del asistente, ver `assistant/rateLimit.ts`).
const HOUR_LIMIT = 10;
const HOUR_TTL_SECONDS = 60 * 60;

export type SignupRateLimitResult = { ok: true } | { ok: false };

export async function checkSignupRateLimit(sourceIp: string): Promise<SignupRateLimitResult> {
  const hourBucket = Math.floor(Date.now() / HOUR_TTL_SECONDS / 1000);
  const within = await incrementWithCap(SIGNUP_USAGE_TABLE, `IP#${sourceIp}#WINDOW#HOUR#${hourBucket}`, HOUR_LIMIT, HOUR_TTL_SECONDS);
  return within ? { ok: true } : { ok: false };
}
