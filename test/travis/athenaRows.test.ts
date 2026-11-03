const mockAthenaSend = jest.fn();

jest.mock("@aws-sdk/client-athena", () => {
  const actual = jest.requireActual("@aws-sdk/client-athena");
  return {
    ...actual,
    AthenaClient: jest.fn().mockImplementation(() => ({ send: (...args: unknown[]) => mockAthenaSend(...args) })),
  };
});

import { GetQueryExecutionCommand, GetQueryResultsCommand, StartQueryExecutionCommand } from "@aws-sdk/client-athena";

import { runAthenaRows } from "../../src/widgets/athenaQuery";

const columns = [{ Name: "Hour_Label" }, { Name: "sales" }];
const cell = (value: string | undefined) => ({ VarCharValue: value });

beforeEach(() => {
  mockAthenaSend.mockReset();
});

test("junta todas las páginas, usa nombres de columna en minúsculas y descarta el encabezado solo de la primera", async () => {
  const pages = [
    {
      NextToken: "n1",
      ResultSet: {
        ResultSetMetadata: { ColumnInfo: columns },
        Rows: [{ Data: [cell("hour_label"), cell("sales")] }, { Data: [cell("2026-11-03 10"), cell("100")] }],
      },
    },
    { ResultSet: { ResultSetMetadata: { ColumnInfo: columns }, Rows: [{ Data: [cell("2026-11-03 11"), cell(undefined)] }] } },
  ];
  mockAthenaSend.mockImplementation((command) => {
    if (command instanceof StartQueryExecutionCommand) return Promise.resolve({ QueryExecutionId: "q1" });
    if (command instanceof GetQueryExecutionCommand) return Promise.resolve({ QueryExecution: { Status: { State: "SUCCEEDED" } } });
    if (command instanceof GetQueryResultsCommand) return Promise.resolve(command.input.NextToken ? pages[1] : pages[0]);
    throw new Error("comando inesperado");
  });

  const rows = await runAthenaRows("SELECT 1", [], "wg");

  expect(rows).toEqual([
    { hour_label: "2026-11-03 10", sales: "100" },
    { hour_label: "2026-11-03 11", sales: null },
  ]);
  const resultCalls = mockAthenaSend.mock.calls.map(([cmd]) => cmd).filter((cmd) => cmd instanceof GetQueryResultsCommand);
  expect(resultCalls.map((cmd) => cmd.input.NextToken)).toEqual([undefined, "n1"]);
});

test("sin filas de datos devuelve una lista vacía", async () => {
  mockAthenaSend.mockImplementation((command) => {
    if (command instanceof StartQueryExecutionCommand) return Promise.resolve({ QueryExecutionId: "q1" });
    if (command instanceof GetQueryExecutionCommand) return Promise.resolve({ QueryExecution: { Status: { State: "SUCCEEDED" } } });
    return Promise.resolve({ ResultSet: { ResultSetMetadata: { ColumnInfo: columns }, Rows: [{ Data: [cell("hour_label"), cell("sales")] }] } });
  });

  expect(await runAthenaRows("SELECT 1", [], "wg")).toEqual([]);
});

test("un resultado que nunca termina de paginar falla en vez de colgarse", async () => {
  mockAthenaSend.mockImplementation((command) => {
    if (command instanceof StartQueryExecutionCommand) return Promise.resolve({ QueryExecutionId: "q1" });
    if (command instanceof GetQueryExecutionCommand) return Promise.resolve({ QueryExecution: { Status: { State: "SUCCEEDED" } } });
    return Promise.resolve({ NextToken: "again", ResultSet: { ResultSetMetadata: { ColumnInfo: columns }, Rows: [] } });
  });

  await expect(runAthenaRows("SELECT 1", [], "wg")).rejects.toThrow("páginas");
});

test("si la consulta falla, propaga el motivo", async () => {
  mockAthenaSend.mockImplementation((command) => {
    if (command instanceof StartQueryExecutionCommand) return Promise.resolve({ QueryExecutionId: "q1" });
    return Promise.resolve({ QueryExecution: { Status: { State: "FAILED", StateChangeReason: "SYNTAX_ERROR" } } });
  });

  await expect(runAthenaRows("SELECT", [], "wg")).rejects.toThrow("SYNTAX_ERROR");
});
