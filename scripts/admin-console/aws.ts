import { execFileSync } from "node:child_process";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { createAdminData, type AdminTables } from "./data.js";

const STACK_NAME = "TicketParsingCloudStack";
const REGION = "us-east-1";

/**
 * Nombres de las tablas: `AGENTS_TABLE` / `TENANTS_TABLE` si están en el
 * entorno; si no, los outputs del stack de CloudFormation (mismo método que
 * `seed-demo-tenant.ts`, con las credenciales de AWS CLI del operador).
 */
export function resolveTables(): AdminTables {
  if (process.env.AGENTS_TABLE && process.env.TENANTS_TABLE) {
    return { agents: process.env.AGENTS_TABLE, tenants: process.env.TENANTS_TABLE, tickets: process.env.TICKETS_TABLE };
  }
  const raw = execFileSync(
    "aws",
    ["cloudformation", "describe-stacks", "--stack-name", STACK_NAME, "--region", REGION, "--query", "Stacks[0].Outputs", "--output", "json"],
    { encoding: "utf-8", shell: process.platform === "win32" },
  );
  const outputs = Object.fromEntries((JSON.parse(raw) as Array<{ OutputKey: string; OutputValue: string }>).map((o) => [o.OutputKey, o.OutputValue]));
  if (!outputs.AgentsTableName || !outputs.TenantsTableName) throw new Error("el stack no tiene los outputs AgentsTableName / TenantsTableName");
  return { agents: outputs.AgentsTableName, tenants: outputs.TenantsTableName, tickets: outputs.TicketsTableName };
}

export function connectAdminData() {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  return createAdminData(ddb, resolveTables());
}
