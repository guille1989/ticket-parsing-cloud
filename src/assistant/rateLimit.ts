import { ASSISTANT_USAGE_TABLE } from "../shared/dynamo.js";
import { incrementWithCap } from "../shared/rateLimit.js";

// Sin api-key en este endpoint (es Cognito, ver PROYECTO.md sección 13), el
// usage plan de API Gateway (10 rps por api-key) no aplica acá — lo único
// que protegía esta ruta era el throttling de la API entera (50 rps),
// compartido entre TODOS los tenants. Doble ventana por tenant: una corta
// (frena un loop/bug del cliente, la misma clase de falla que disparó el
// incidente de costo de S3 en la sección 10.1) y una diaria (tope de costo
// agregado por negocio).
const MINUTE_LIMIT = 6;
const DAY_LIMIT = 150;
const MINUTE_TTL_SECONDS = 120;
const DAY_TTL_SECONDS = 2 * 24 * 60 * 60;

export type RateLimitResult = { ok: true } | { ok: false; reason: "minute" | "day" };

export async function checkAssistantRateLimit(tenantId: string): Promise<RateLimitResult> {
  const now = new Date();
  const minuteBucket = Math.floor(now.getTime() / 60_000);
  const dayBucket = now.toISOString().slice(0, 10);

  const withinMinute = await incrementWithCap(
    ASSISTANT_USAGE_TABLE,
    `TENANT#${tenantId}#WINDOW#MIN#${minuteBucket}`,
    MINUTE_LIMIT,
    MINUTE_TTL_SECONDS,
  );
  if (!withinMinute) return { ok: false, reason: "minute" };

  const withinDay = await incrementWithCap(
    ASSISTANT_USAGE_TABLE,
    `TENANT#${tenantId}#WINDOW#DAY#${dayBucket}`,
    DAY_LIMIT,
    DAY_TTL_SECONDS,
  );
  if (!withinDay) return { ok: false, reason: "day" };

  return { ok: true };
}
