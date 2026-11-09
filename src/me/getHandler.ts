import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { toPublicProfile } from "./profile.js";
import { resolveActiveTenantFromEvent } from "../shared/auth.js";
import { jsonResponse } from "../shared/http.js";

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
  });
}
