const mockGetTenant = jest.fn();
jest.mock("../../src/shared/tenant", () => ({ getTenant: (...args: unknown[]) => mockGetTenant(...args) }));

import { getBusinessTimeZone } from "../../src/shared/businessTimeZone";

let errorSpy: jest.SpyInstance;
beforeEach(() => {
  mockGetTenant.mockReset();
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errorSpy.mockRestore());

test("devuelve la zona IANA configurada del negocio", async () => {
  mockGetTenant.mockResolvedValue({ tenantId: "t1", advisor: { timeZone: "America/Bogota" } });
  expect(await getBusinessTimeZone("t1")).toBe("America/Bogota");
  expect(mockGetTenant).toHaveBeenCalledWith("t1");
});

test.each([
  ["tenant sin advisor", { tenantId: "t1" }],
  ["advisor sin zona", { tenantId: "t1", advisor: {} }],
  ["zona inválida", { tenantId: "t1", advisor: { timeZone: "Marte/Olympus" } }],
  ["zona con caracteres peligrosos", { tenantId: "t1", advisor: { timeZone: "UTC'); DROP TABLE x;--" } }],
  ["zona que no es texto", { tenantId: "t1", advisor: { timeZone: 5 } }],
  ["tenant inexistente", undefined],
])("sin zona utilizable (%s): undefined, para que se use la del navegador", async (_caso, tenant) => {
  mockGetTenant.mockResolvedValue(tenant);
  expect(await getBusinessTimeZone("t1")).toBeUndefined();
});

test("si no se puede leer el tenant no lanza: undefined (vuelve al comportamiento de antes) y deja el error en el log", async () => {
  mockGetTenant.mockRejectedValue(new Error("ProvisionedThroughputExceededException"));
  await expect(getBusinessTimeZone("t1")).resolves.toBeUndefined();
  expect(errorSpy).toHaveBeenCalled();
});
