import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

const TENANT_CLAIM = "custom:tenantId";

/**
 * Todos los endpoints que usa el dashboard (lecturas de tickets/widgets/
 * agents/activation-codes, más crear/borrar widgets) están detrás de un
 * `CognitoUserPoolsAuthorizer` en API Gateway — para cuando este handler
 * corre, la firma y expiración del JWT ya se validaron, así que acá solo
 * se lee el claim, nunca se revalida nada.
 *
 * `custom:tenantId` lo setea `onboard-tenant.ts` al crear el usuario
 * (`AdminCreateUserCommand`) — es un atributo de admin, el usuario final
 * no tiene forma de tocarlo desde el frontend ni de pedir uno ajeno.
 */
export function resolveTenantIdFromEvent(event: APIGatewayProxyWithCognitoAuthorizerEvent): string | undefined {
  return event.requestContext.authorizer.claims[TENANT_CLAIM];
}
