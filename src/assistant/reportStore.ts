import { randomUUID } from "node:crypto";

import { PutCommand } from "@aws-sdk/lib-dynamodb";

import { ddb, REPORTS_TABLE, reportKey } from "../shared/dynamo.js";

// Los reportes son una foto puntual y no se acumulan: cada item lleva un TTL
// y DynamoDB lo borra solo (sin job de limpieza). El borrado puede demorar
// hasta ~48 h después del vencimiento, por eso las lecturas también filtran
// por `ttl` (ver reports/*).
export const REPORT_RETENTION_DAYS = 30;

export interface StoredReportItem {
  pk: string;
  sk: string;
  reportId: string;
  title: string;
  summary: string;
  report: unknown;
  createdAt: string;
  /** Epoch en segundos: atributo TTL de DynamoDB. */
  ttl: number;
}

export async function saveReport(
  tenantId: string,
  summary: string,
  report: { title: string },
  now: Date = new Date(),
): Promise<{ reportId: string; expiresAt: string }> {
  const createdAt = now.toISOString();
  // ISO primero: el SK ordena cronológicamente y el sufijo evita colisiones en el mismo milisegundo.
  const reportId = `${createdAt}_${randomUUID().slice(0, 8)}`;
  const ttl = Math.floor(now.getTime() / 1000) + REPORT_RETENTION_DAYS * 24 * 60 * 60;
  const item: StoredReportItem = { ...reportKey(tenantId, reportId), reportId, title: report.title, summary, report, createdAt, ttl };
  await ddb.send(new PutCommand({ TableName: REPORTS_TABLE, Item: item }));
  return { reportId, expiresAt: new Date(ttl * 1000).toISOString() };
}
