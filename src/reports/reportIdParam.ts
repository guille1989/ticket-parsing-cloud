import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

/**
 * El reportId lleva un timestamp ISO (`2026-10-19T16:59:00.000Z_ab12cd34`) y los `:`
 * llegan codificados (`%3A`): API Gateway REST entrega los path parameters sin
 * decodificar, así que la clave del GetItem/DeleteItem no coincidía y todo daba 404.
 */
export function reportIdFromEvent(event: APIGatewayProxyWithCognitoAuthorizerEvent): string | undefined {
  const raw = event.pathParameters?.reportId;
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
