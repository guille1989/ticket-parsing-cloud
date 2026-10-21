import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { getTenant } from "./tenant.js";
import type { TenantRecord } from "./types.js";

const TENANT_CLAIM = "custom:tenantId";

/**
 * Todos los endpoints que usa el dashboard (lecturas de tickets/widgets/
 * agents/activation-codes, más crear/borrar widgets) están detrás de un
 * `CognitoUserPoolsAuthorizer` en API Gateway — para cuando este handler
 * corre, la firma y expiración del JWT ya se validaron. Esta función solo
 * extrae el claim; los handlers deben usar resolveActiveTenantFromEvent o
 * resolveActiveTenantIdFromEvent para comprobar además el acceso actual.
 *
 * `custom:tenantId` lo setea `onboard-tenant.ts` al crear el usuario
 * (`AdminCreateUserCommand`) — es un atributo de admin, el usuario final
 * no tiene forma de tocarlo desde el frontend ni de pedir uno ajeno.
 */
export function resolveTenantIdFromEvent(event: APIGatewayProxyWithCognitoAuthorizerEvent): string | undefined {
  const tenantId = event.requestContext?.authorizer?.claims?.[TENANT_CLAIM];
  return typeof tenantId === "string" && tenantId.trim() ? tenantId : undefined;
}

/**
 * Cognito valida el JWT, pero un token emitido antes de bloquear el negocio
 * puede seguir vigente. Cada petición humana comprueba el registro actual,
 * sin caché y con lectura consistente. Ante un fallo de lectura se deniega
 * el acceso; nunca se continúa utilizando solo el claim del token.
 */
export async function resolveActiveTenantFromEvent(
  event: APIGatewayProxyWithCognitoAuthorizerEvent,
): Promise<TenantRecord | undefined> {
  const tenantId = resolveTenantIdFromEvent(event);
  if (!tenantId) return undefined;

  try {
    const tenant = await getTenant(tenantId, { consistentRead: true });
    if (!tenant || tenant.tenantId !== tenantId || (tenant.status !== undefined && tenant.status !== "active")) {
      return undefined;
    }
    return tenant;
  } catch {
    console.error("No se pudo verificar el acceso al negocio");
    return undefined;
  }
}

/** Identidad de la persona logueada (claim `sub` del JWT, ya validado por el authorizer de Cognito). */
export function resolveUserIdFromEvent(event: APIGatewayProxyWithCognitoAuthorizerEvent): string | undefined {
  const sub = event.requestContext?.authorizer?.claims?.sub;
  return typeof sub === "string" && sub.trim() ? sub : undefined;
}

export async function resolveActiveTenantIdFromEvent(
  event: APIGatewayProxyWithCognitoAuthorizerEvent,
): Promise<string | undefined> {
  return (await resolveActiveTenantFromEvent(event))?.tenantId;
}
