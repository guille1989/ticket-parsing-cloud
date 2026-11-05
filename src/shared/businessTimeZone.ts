import { isValidTimeZone } from "../widgets/fields.js";
import { getTenant } from "./tenant.js";

/**
 * Zona horaria IANA del NEGOCIO (`advisor.timeZone` del tenant, ver
 * `scripts/set-tenant-timezone.ts`), o `undefined` si no tiene una válida.
 *
 * Las horas pico, "ventas de hoy" o "por hora" se miran en la hora del local,
 * no en la de quien consulta: un dueño colombiano que abre el dashboard desde
 * Europa (o un asesor que lo mira de viaje) tiene que ver las 5 p. m. de
 * Colombia, no las 12 de la noche de su navegador. El llamador usa la zona del
 * navegador solo como respaldo cuando el negocio no tiene una configurada.
 *
 * Nunca lanza: si el tenant no se puede leer, el respaldo es el comportamiento
 * de antes (zona del navegador), no un error en la consulta.
 */
export async function getBusinessTimeZone(tenantId: string): Promise<string | undefined> {
  try {
    const zone = (await getTenant(tenantId))?.advisor?.timeZone;
    return typeof zone === "string" && isValidTimeZone(zone) ? zone : undefined;
  } catch (err) {
    console.error(`[timezone] no se pudo leer la zona horaria del tenant ${tenantId}:`, err);
    return undefined;
  }
}
