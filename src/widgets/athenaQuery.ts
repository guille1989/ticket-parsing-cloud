import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from "@aws-sdk/client-athena";

const athena = new AthenaClient({});

// Athena devuelve el resultado de una ejecución idéntica reciente (mismo SQL,
// mismos parámetros, mismo workgroup) sin volver a escanear S3. El dashboard
// re-consulta cada widget cada 30 s y cada consulta lee ~2.500 objetos chicos
// (ver el pico de costo de octubre de 2026); con esto las repeticiones salen
// gratis. El costo: un ticket nuevo puede tardar hasta este tiempo en verse.
const RESULT_REUSE_MAX_AGE_MINUTES = 1;

const POLL_INTERVAL_MS = 500;
const MAX_POLL_ATTEMPTS = 40; // ~20s — a este volumen de datos, Athena suele responder en 1-3s.

export interface WidgetDataPoint {
  label?: string;
  value: number | null;
  /** Número de observaciones del promedio; permite reagrupar sin promediar promedios. */
  sampleCount?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Athena no toma cada `ExecutionParameters` como un string ya tipado: lo
 * parsea como un literal SQL. Sin comillas, "2026-10-01" se evalúa como la
 * resta 2026 - 10 - 1 = 2015 (entero) y `capturedat >= ?` falla con
 * `TYPE_MISMATCH: varchar <= integer` — así se rompía el filtro de fechas
 * del asistente (2026-10-16, "ventas de octubre"). Todos los valores que
 * arma queryBuilder.ts son strings, así que se mandan siempre como literal
 * de texto, escapando la comilla simple ('' en SQL) para que un valor con
 * comillas no pueda cerrar el literal.
 */
function toSqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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
      ExecutionParameters: params.map(toSqlStringLiteral),
      WorkGroup: workGroup,
      ResultReuseConfiguration: {
        ResultReuseByAgeConfiguration: { Enabled: true, MaxAgeInMinutes: RESULT_REUSE_MAX_AGE_MINUTES },
      },
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
  const columns = results.ResultSet?.ResultSetMetadata?.ColumnInfo ?? [];
  const names = columns.map((column, index) => (column.Name ?? rows[0].Data?.[index]?.VarCharValue ?? "").toLowerCase());
  const namedValue = names.indexOf("value");
  // La posición se conserva como compatibilidad para metadatos antiguos.
  const hasLabel = names.includes("label") || (namedValue < 0 && columns.length > 1);
  const labelIndex = Math.max(0, names.indexOf("label"));
  const valueIndex = namedValue >= 0 ? namedValue : hasLabel ? 1 : 0;
  const sampleCountIndex = names.indexOf("sample_count");
  const numericValue = (value: string | undefined): number | null => {
    if (value === undefined || value.trim() === "") return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error("Athena devolvió un valor numérico inválido");
    return numeric;
  };

  return dataRows.map((row) => {
    const values = (row.Data ?? []).map((cell) => cell.VarCharValue);
    const point: WidgetDataPoint = { value: numericValue(values[valueIndex]) };
    if (hasLabel) point.label = values[labelIndex] ?? "(sin dato)";
    if (sampleCountIndex >= 0) {
      const sampleCount = numericValue(values[sampleCountIndex]);
      if (sampleCount === null || !Number.isSafeInteger(sampleCount) || sampleCount < 0) {
        throw new Error("Athena devolvió un número de observaciones inválido");
      }
      point.sampleCount = sampleCount;
    }
    return point;
  });
}
