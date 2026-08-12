import type { PreAuthenticationTriggerEvent } from "aws-lambda";

import { getTenant } from "../shared/tenant.js";

/**
 * Trigger de Cognito — corre ANTES de que Cognito deje entrar a alguien,
 * para cualquier flujo de login con contraseña (`USER_PASSWORD_AUTH`,
 * el que usa el dashboard). Tirar cualquier excepción acá corta el login
 * con un error; devolver el evento tal cual lo deja pasar.
 *
 * `custom:tenantId` ya viene resuelto en `userAttributes` — no hace falta
 * (ni se puede) tocar el JWT todavía en esta etapa, el trigger solo decide
 * sí/no. Ver `scripts/set-tenant-status.ts` para cómo se bloquea un tenant,
 * y por qué eso además corta las sesiones ya abiertas con
 * `AdminUserGlobalSignOut` — este trigger NO corre en `REFRESH_TOKEN_AUTH`,
 * así que bloquear acá solo no alcanza para una sesión que ya tenía un
 * refresh token vigente.
 */
export async function handler(event: PreAuthenticationTriggerEvent): Promise<PreAuthenticationTriggerEvent> {
  const tenantId = event.request.userAttributes["custom:tenantId"];
  if (tenantId) {
    const tenant = await getTenant(tenantId);
    if (tenant?.status === "blocked") {
      throw new Error("Esta cuenta está bloqueada.");
    }
  }
  return event;
}
