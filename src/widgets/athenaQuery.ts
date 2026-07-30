import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from "@aws-sdk/client-athena";

const athena = new AthenaClient({});

const POLL_INTERVAL_MS = 500;
const MAX_POLL_ATTEMPTS = 40; // ~20s — a este volumen de datos, Athena suele responder en 1-3s.

export interface WidgetDataPoint {
  label?: string;
  value: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Corre una consulta de Athena de punta a punta: dispara, sondea hasta que
 * termina, y trae los resultados ya transformados a algo simple para
 * graficar. Athena es async por naturaleza (no hay una API síncrona de
 * "correr y esperar"), así que esto lo resuelve sondeando dentro del mismo
 * Lambda — razonable a este volumen de datos, no hace falta nada más
 * elaborado (colas, WebSocket) todavía.
 */
export async function runWidgetQuery(sql: string, params: string[], workGroup: string): Promise<WidgetDataPoint[]> {
  const start = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      ExecutionParameters: params,
      WorkGroup: workGroup,
    }),
  );
  const queryExecutionId = start.QueryExecutionId;
  if (!queryExecutionId) {
    throw new Error("Athena no devolvió un QueryExecutionId");
  }

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const execution = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId }));
    const state = execution.QueryExecution?.Status?.State;

    if (state === "SUCCEEDED") {
      return fetchResults(queryExecutionId);
    }
    if (state === "FAILED" || state === "CANCELLED") {
      const reason = execution.QueryExecution?.Status?.StateChangeReason ?? "sin detalle";
      throw new Error(`la consulta de Athena falló: ${reason}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error("timeout esperando el resultado de la consulta de Athena");
}

async function fetchResults(queryExecutionId: string): Promise<WidgetDataPoint[]> {
  const results = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: queryExecutionId }));
  const rows = results.ResultSet?.Rows ?? [];
  if (rows.length === 0) return [];

  // La primera fila es el encabezado con los nombres de columna, no un dato.
  const [, ...dataRows] = rows;
  const hasLabel = (results.ResultSet?.ResultSetMetadata?.ColumnInfo?.length ?? 0) > 1;

  return dataRows.map((row) => {
    const values = (row.Data ?? []).map((cell) => cell.VarCharValue);
    if (hasLabel) {
      return { label: values[0] ?? "(sin dato)", value: Number(values[1]) || 0 };
    }
    return { value: Number(values[0]) || 0 };
  });
}
