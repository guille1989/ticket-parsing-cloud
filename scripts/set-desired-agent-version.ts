/**
 * Fija (o limpia) la desiredVersion OTA global / por agent (Fase 1).
 *
 * Kill-switch de flota: `--clear` sin `--agent` (o `--version` vacío con `--apply`).
 * Pin / canary corta: `--agent <id> --tenant <id> --version X.Y.Z --apply`.
 *
 * Por defecto dry-run; `--apply` escribe.
 *
 * Uso:
 *   npm run set-desired-agent-version -- --version 0.5.1
 *   npm run set-desired-agent-version -- --version 0.5.1 --apply
 *   npm run set-desired-agent-version -- --clear --apply
 *   npm run set-desired-agent-version -- --tenant t1 --agent a1 --version 0.5.1 --apply
 *   npm run set-desired-agent-version -- --tenant t1 --agent a1 --clear --apply
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import { OTA_GLOBAL_KEY } from "../src/agents/otaPolicy.js";
import { agentKey } from "../src/shared/dynamo.js";
import { readStackOutputs, requireOutput } from "./lib/stackOutputs.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function assertSemverLike(version: string): void {
  if (!/^\d+\.\d+\.\d+([.-][A-Za-z0-9.-]+)?$/.test(version)) {
    throw new Error(`versión inválida "${version}" (esperado semver-like, ej. 0.5.1)`);
  }
}

async function main(): Promise<void> {
  const clear = process.argv.includes("--clear");
  const apply = process.argv.includes("--apply");
  const versionRaw = arg("version");
  const tenantId = arg("tenant");
  const agentId = arg("agent");

  if ((tenantId && !agentId) || (!tenantId && agentId)) {
    throw new Error("para override por agent pasá --tenant y --agent juntos");
  }
  if (clear && versionRaw) {
    throw new Error("no combines --clear con --version");
  }
  if (!clear && !versionRaw) {
    throw new Error("pasá --version <semver> o --clear");
  }
  if (versionRaw) assertSemverLike(versionRaw);

  const agentsTable = requireOutput(readStackOutputs(), "AgentsTableName");
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
  const now = new Date().toISOString();

  if (tenantId && agentId) {
    const key = agentKey(tenantId, agentId);
    const { Item } = await ddb.send(new GetCommand({ TableName: agentsTable, Key: key, ConsistentRead: true }));
    if (!Item) throw new Error(`no existe agent ${agentId} en tenant ${tenantId}`);
    console.log(`Agent ${Item.name ?? agentId} (${tenantId}/${agentId})`);
    console.log(`  desiredVersion actual: ${Item.desiredVersion ?? "(hereda global)"}`);
    console.log(`  desiredVersion nueva:  ${clear ? "(hereda global)" : versionRaw}`);
    if (!apply) {
      console.log("  (dry-run: agregá --apply para escribir)");
      return;
    }
    if (clear) {
      await ddb.send(new UpdateCommand({
        TableName: agentsTable,
        Key: key,
        UpdateExpression: "REMOVE desiredVersion",
        ConditionExpression: "attribute_exists(pk)",
      }));
    } else {
      await ddb.send(new UpdateCommand({
        TableName: agentsTable,
        Key: key,
        UpdateExpression: "SET desiredVersion = :v",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeValues: { ":v": versionRaw },
      }));
    }
    console.log("  listo.");
    return;
  }

  const { Item } = await ddb.send(new GetCommand({ TableName: agentsTable, Key: OTA_GLOBAL_KEY, ConsistentRead: true }));
  console.log("Policy OTA global (OTA#GLOBAL / POLICY)");
  console.log(`  desiredVersion actual: ${(Item as { desiredVersion?: string } | undefined)?.desiredVersion ?? "(ninguna — sin OTA)"}`);
  console.log(`  desiredVersion nueva:  ${clear ? "(ninguna — kill-switch)" : versionRaw}`);
  if (!apply) {
    console.log("  (dry-run: agregá --apply para escribir)");
    return;
  }
  if (clear) {
    await ddb.send(new UpdateCommand({
      TableName: agentsTable,
      Key: OTA_GLOBAL_KEY,
      UpdateExpression: "REMOVE desiredVersion SET updatedAt = :now",
      ExpressionAttributeValues: { ":now": now },
    }));
  } else {
    await ddb.send(new UpdateCommand({
      TableName: agentsTable,
      Key: OTA_GLOBAL_KEY,
      UpdateExpression: "SET desiredVersion = :v, updatedAt = :now",
      ExpressionAttributeValues: { ":v": versionRaw, ":now": now },
    }));
  }
  console.log("  listo.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
