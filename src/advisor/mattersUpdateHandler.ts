import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { resolveActiveTenantIdFromEvent } from "../shared/auth.js";
import { jsonResponse } from "../shared/http.js";
import { internalMatterId, loadBranchLabels, toPublicMatter } from "./matterApi.js";
import { markMatter, type MatterAction } from "./matterStore.js";

const ACTIONS: readonly MatterAction[] = ["seen", "dismissed"];

/** PATCH /advisor/matters/{matterId} con `{ "status": "seen" | "dismissed" }`: lo que hace el dueño con un asunto. */
export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenantId = await resolveActiveTenantIdFromEvent(event);
  if (!tenantId) {
    return jsonResponse(403, { error: "no autenticado" });
  }

  const publicId = event.pathParameters?.matterId;
  const matterId = publicId ? internalMatterId(publicId) : null;
  if (!matterId) {
    return jsonResponse(404, { error: "asunto no encontrado" });
  }

  let body: unknown;
  try {
    body = event.body ? JSON.parse(event.body) : null;
  } catch {
    return jsonResponse(400, { error: "body inválido, se esperaba JSON" });
  }
  const status = body && typeof body === "object" ? (body as Record<string, unknown>).status : undefined;
  if (typeof status !== "string" || !ACTIONS.includes(status as MatterAction)) {
    return jsonResponse(400, { error: `status inválido, se esperaba uno de: ${ACTIONS.join(", ")}` });
  }

  const result = await markMatter(tenantId, matterId, status as MatterAction);
  if (!result.ok) {
    if (result.reason === "not_found") return jsonResponse(404, { error: "asunto no encontrado" });
    if (result.reason === "resolved") return jsonResponse(409, { error: "el asunto ya se resolvió solo" });
    return jsonResponse(409, { error: "el asunto cambió mientras lo marcabas, intentá de nuevo" });
  }
  return jsonResponse(200, { matter: toPublicMatter(result.item, await loadBranchLabels(tenantId)) });
}
