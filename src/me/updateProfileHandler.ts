import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { mergeProfile, parseProfilePatch, profileClears, toPublicProfile } from "./profile.js";
import { resolveActiveTenantFromEvent } from "../shared/auth.js";
import { ddb, TENANTS_TABLE, tenantKey } from "../shared/dynamo.js";
import { jsonResponse } from "../shared/http.js";
import type { TenantProfile } from "../shared/types.js";

export async function handler(event: APIGatewayProxyWithCognitoAuthorizerEvent): Promise<APIGatewayProxyResult> {
  const tenant = await resolveActiveTenantFromEvent(event);
  if (!tenant) return jsonResponse(403, { error: "no autenticado" });

  let body: unknown;
  try {
    body = event.body ? JSON.parse(event.body) : null;
  } catch {
    return jsonResponse(400, { error: "body inválido, se esperaba JSON" });
  }

  const parsed = parseProfilePatch(body);
  if (!parsed.ok) return jsonResponse(400, { error: parsed.error });

  const clears = profileClears(body);
  // openingHours: {} (sin default ni byWeekday) se trata como borrado.
  if (
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    "openingHours" in body &&
    (body as Record<string, unknown>).openingHours !== null &&
    !("openingHours" in parsed.profile)
  ) {
    clears.add("openingHours");
  }

  const next = mergeProfile(tenant.profile, parsed.profile, clears);

  if (next === undefined) {
    await ddb.send(
      new UpdateCommand({
        TableName: TENANTS_TABLE,
        Key: tenantKey(tenant.tenantId),
        UpdateExpression: "REMOVE profile",
      }),
    );
    return jsonResponse(200, { profile: null });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: TENANTS_TABLE,
      Key: tenantKey(tenant.tenantId),
      UpdateExpression: "SET profile = :profile",
      ExpressionAttributeValues: { ":profile": next satisfies TenantProfile },
    }),
  );
  return jsonResponse(200, { profile: toPublicProfile(next) });
}
