import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { toPublicProfile } from "./profile.js";
import { resolveActiveTenantFromEvent } from "../shared/auth.js";
import { jsonResponse } from "../shared/http.js";
import { isValidTimeZone } from "../widgets/fields.js";

/**
 * Zona IANA del negocio (`advisor.timeZone`), la misma que Ask y dataHandler.
 * null si no hay una válida — el cliente cae al navegador, igual que Ask.
 */
function publicBusinessTimeZone(advisor: { timeZone?: unknown } | undefined): string | null {
  const zone = advisor?.timeZone;
  return typeof zone === "string" && isValidTimeZone(zone) ? zone : null;
}

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenant = await resolveActiveTenantFromEvent(event);
  if (!tenant) return jsonResponse(403, { error: "no autenticado" });

  return jsonResponse(200, {
    tenantId: tenant.tenantId,
    businessName: tenant.businessName,
    createdAt: tenant.createdAt,
    // null, y no un objeto vacío, distingue tenants anteriores al flujo.
    onboarding: tenant.onboarding ?? null,
    // Ficha de negocio (P1): moneda, horarios, rubro. null si no está cargada.
    profile: toPublicProfile(tenant.profile),
    // Interruptores de funciones en beta, por negocio: ausente = apagado.
    features: { advisorView: tenant.advisor?.betaView === true },
    // «Hoy» / periodos del dashboard deben usar esta zona (Ask ya lo hace).
    timeZone: publicBusinessTimeZone(tenant.advisor),
  });
}
