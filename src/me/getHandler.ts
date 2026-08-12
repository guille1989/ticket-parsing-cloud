import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveTenantIdFromEvent } from "../shared/auth.js";
import { jsonResponse } from "../shared/http.js";
import { getTenant } from "../shared/tenant.js";

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = resolveTenantIdFromEvent(event);
  if (!tenantId) return jsonResponse(403, { error: "no autenticado" });

  const tenant = await getTenant(tenantId);
  if (!tenant) return jsonResponse(404, { error: "negocio no encontrado" });

  return jsonResponse(200, {
    tenantId: tenant.tenantId,
    businessName: tenant.businessName,
    createdAt: tenant.createdAt,
    // null, y no un objeto vacío, distingue tenants anteriores al flujo.
    onboarding: tenant.onboarding ?? null,
  });
}
