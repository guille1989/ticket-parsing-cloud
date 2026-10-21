import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

/**
 * El id lleva `:` (ISO) y llegan codificados (`%3A`), igual que el reportId: API Gateway REST
 * entrega los path parameters sin decodificar.
 */
export function conversationIdFromEvent(event: APIGatewayProxyWithCognitoAuthorizerEvent): string | undefined {
  const raw = event.pathParameters?.conversationId;
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
