const mockAthenaSend = jest.fn();

jest.mock("@aws-sdk/client-athena", () => {
  const actual = jest.requireActual("@aws-sdk/client-athena");
  return {
    ...actual,
    AthenaClient: jest.fn().mockImplementation(() => ({ send: (...args: unknown[]) => mockAthenaSend(...args) })),
  };
});

import {
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from "@aws-sdk/client-athena";

import { runWidgetQuery } from "../../src/widgets/athenaQuery";

function resultSet(columnCount: number, rows: string[][]) {
  return {
    ResultSet: {
      ResultSetMetadata: { ColumnInfo: Array.from({ length: columnCount }, () => ({})) },
      Rows: [
        { Data: Array.from({ length: columnCount }, () => ({ VarCharValue: "header" })) }, // fila de encabezados
        ...rows.map((row) => ({ Data: row.map((value) => ({ VarCharValue: value })) })),
      ],
    },
  };
}

beforeEach(() => {
  mockAthenaSend.mockReset();
});

test("KPI (una sola columna): devuelve un value por fila, sin label", async () => {
  mockAthenaSend.mockImplementation((command) => {
    if (command instanceof StartQueryExecutionCommand) return Promise.resolve({ QueryExecutionId: "q1" });
    if (command instanceof GetQueryExecutionCommand) {
      return Promise.resolve({ QueryExecution: { Status: { State: "SUCCEEDED" } } });
    }
    if (command instanceof GetQueryResultsCommand) return Promise.resolve(resultSet(1, [["1800"]]));
    throw new Error("comando inesperado");
  });

  const data = await runWidgetQuery("SELECT SUM(total) AS value FROM x WHERE tenant = ?", ["t1"], "wg");

  expect(data).toEqual([{ value: 1800 }]);
});

test("bar/donut (dos columnas): devuelve label + value por fila", async () => {
  mockAthenaSend.mockImplementation((command) => {
    if (command instanceof StartQueryExecutionCommand) return Promise.resolve({ QueryExecutionId: "q1" });
    if (command instanceof GetQueryExecutionCommand) {
      return Promise.resolve({ QueryExecution: { Status: { State: "SUCCEEDED" } } });
    }
    if (command instanceof GetQueryResultsCommand) {
      return Promise.resolve(
        resultSet(2, [
          ["Café", "1800"],
          ["Medialuna", "900"],
        ]),
      );
    }
    throw new Error("comando inesperado");
  });

  const data = await runWidgetQuery("SELECT description AS label, SUM(subtotal) AS value FROM x", [], "wg");

  expect(data).toEqual([
    { label: "Café", value: 1800 },
    { label: "Medialuna", value: 900 },
  ]);
});

test("sondea hasta que el estado deja de ser QUEUED/RUNNING", async () => {
  let executionCalls = 0;
  mockAthenaSend.mockImplementation((command) => {
    if (command instanceof StartQueryExecutionCommand) return Promise.resolve({ QueryExecutionId: "q1" });
    if (command instanceof GetQueryExecutionCommand) {
      executionCalls++;
      const state = executionCalls < 3 ? "RUNNING" : "SUCCEEDED";
      return Promise.resolve({ QueryExecution: { Status: { State: state } } });
    }
    if (command instanceof GetQueryResultsCommand) return Promise.resolve(resultSet(1, [["42"]]));
    throw new Error("comando inesperado");
  });

  const data = await runWidgetQuery("SELECT 1", [], "wg");

  expect(executionCalls).toBe(3);
  expect(data).toEqual([{ value: 42 }]);
});

test("la consulta falla en Athena: rechaza con el motivo", async () => {
  mockAthenaSend.mockImplementation((command) => {
    if (command instanceof StartQueryExecutionCommand) return Promise.resolve({ QueryExecutionId: "q1" });
    if (command instanceof GetQueryExecutionCommand) {
      return Promise.resolve({
        QueryExecution: { Status: { State: "FAILED", StateChangeReason: "columna no existe" } },
      });
    }
    throw new Error("no debería llegar acá");
  });

  await expect(runWidgetQuery("SELECT x", [], "wg")).rejects.toThrow(/columna no existe/);
});

test("sin filas de datos (solo encabezado o vacío): devuelve array vacío", async () => {
  mockAthenaSend.mockImplementation((command) => {
    if (command instanceof StartQueryExecutionCommand) return Promise.resolve({ QueryExecutionId: "q1" });
    if (command instanceof GetQueryExecutionCommand) {
      return Promise.resolve({ QueryExecution: { Status: { State: "SUCCEEDED" } } });
    }
    if (command instanceof GetQueryResultsCommand) return Promise.resolve(resultSet(1, []));
    throw new Error("comando inesperado");
  });

  const data = await runWidgetQuery("SELECT 1", [], "wg");
  expect(data).toEqual([]);
});
