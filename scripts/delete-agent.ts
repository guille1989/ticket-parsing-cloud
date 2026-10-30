// Script administrativo — borra UNO O VARIOS agentes de un negocio (su
// api-key de API Gateway, su registro y los diagnósticos que tuviera). NO toca
// el negocio, sus tickets, sus códigos de activación ni los demás agentes.
// Sirve para quitar de la lista (y del dashboard del cliente) robots
// desinstalados. IRREVERSIBLE.
//
// Sin --confirm solo muestra qué borraría (modo prueba). Se niega a borrar un
// agente que se reportó hace menos de 15 minutos, salvo --force.
//
// Uso (desde ticket-parsing-cloud/, con las credenciales de AWS CLI; las tablas
// se leen del stack de CloudFormation):
//   npm run delete-agent -- --tenant <tenantId> --agent <agentId>[,<agentId>…]            # prueba
//   npm run delete-agent -- --tenant <tenantId> --agent <agentId>[,<agentId>…] --confirm  # borra
import { APIGatewayClient } from "@aws-sdk/client-api-gateway";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

import { resolveTables } from "./admin-console/aws.js";
import { executeAgentDeletion, LIVE_WINDOW_MS, planAgentDeletion, type DeleteAgentDeps } from "./lib/deleteAgent.js";

const REGION = "us-east-1";
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const ago = (iso?: string) => {
  if (!iso) return "nunca";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? `hace ${s} s` : s < 5400 ? `hace ${Math.round(s / 60)} min` : s < 129600 ? `hace ${Math.round(s / 3600)} h` : `hace ${Math.round(s / 86400)} d`;
};

async function main(): Promise<void> {
  const tenantId = arg("tenant");
  const agentIds = (arg("agent") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const confirm = process.argv.includes("--confirm");
  const force = process.argv.includes("--force");
  if (!tenantId || !ID_PATTERN.test(tenantId) || agentIds.length === 0 || !agentIds.every((id) => ID_PATTERN.test(id))) {
    throw new Error("uso: delete-agent --tenant <tenantId> --agent <agentId>[,<agentId>…] [--confirm] [--force]");
  }

  const tables = resolveTables();
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const deps: DeleteAgentDeps = {
    ddb,
    apigw: new APIGatewayClient({ region: REGION }),
    agentsTable: tables.agents,
    ticketsTable: tables.tickets,
  };

  const tenant = await ddb.send(new GetCommand({ TableName: tables.tenants, Key: { pk: `TENANT#${tenantId}` } }));
  if (!tenant.Item) throw new Error(`no existe ningún negocio con id ${tenantId}`);
  console.log(`Negocio: ${tenant.Item.businessName} (${tenantId})${confirm ? "" : "   [MODO PRUEBA: no se borra nada]"}\n`);

  let problems = 0;
  for (const agentId of agentIds) {
    try {
      const plan = await planAgentDeletion(deps, tenantId, agentId);
      console.log(`Agente "${plan.name}" (${agentId})  v${plan.version ?? "?"}  visto ${ago(plan.lastSeenAt)}`);
      console.log(`  api-key a borrar:        ${plan.apiKeyId ?? "(ninguna)"}`);
      console.log(`  diagnósticos a borrar:   ${plan.commandKeys.length}`);
      console.log(`  tickets que subió:       ${plan.ticketCount ?? "?"}  (NO se borran)`);

      if (plan.live && !force) {
        console.error(`  OMITIDO: se reportó hace menos de ${LIVE_WINDOW_MS / 60000} min, sigue conectado. Desinstálalo primero (o usa --force).\n`);
        problems++;
        continue;
      }
      if (!confirm) {
        console.log("  (modo prueba) con --confirm se borraría.\n");
        continue;
      }
      await executeAgentDeletion(deps, plan);
      console.log("  BORRADO.\n");
    } catch (err) {
      problems++;
      console.error(`  ERROR con ${agentId}:`, err instanceof Error ? err.message : err, "\n");
    }
  }
  if (problems > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
