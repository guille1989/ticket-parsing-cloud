import type { APIGatewayProxyResult } from "aws-lambda";

/**
 * `defaultCorsPreflightOptions` en el stack de CDK solo configura el
 * método `OPTIONS` (el preflight) — la respuesta real de cada Lambda
 * (200, 400, 403, lo que sea) tiene que traer estos headers ella misma,
 * o el navegador la bloquea igual aunque el preflight haya salido bien.
 * `innoapp-web-user-client` lo pisó justo por esto: preflight ok, pero
 * la respuesta de verdad sin `Access-Control-Allow-Origin` → "Failed to
 * fetch" en la consola del navegador.
 */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
};

export function jsonResponse(statusCode: number, body?: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: body === undefined ? "" : JSON.stringify(body),
  };
}
