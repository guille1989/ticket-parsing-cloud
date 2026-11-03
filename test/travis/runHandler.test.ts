const mockRunTenant = jest.fn();
const mockListTenants = jest.fn();

jest.mock("../../src/travis/runner", () => ({ runTenant: (...args: unknown[]) => mockRunTenant(...args) }));
jest.mock("../../src/travis/opsData", () => ({ listTravisTenants: () => mockListTenants() }));

import { handler } from "../../src/travis/runHandler";

const result = (tenantId: string, errors: string[] = []) => ({
  tenantId,
  businessName: tenantId,
  timeZone: "UTC",
  ranDaily: true,
  ranHourly: true,
  dryRun: false,
  candidates: [{ detector: "agent_offline", scope: "branch:a1", severity: "warn", periodDate: "2026-11-04", evidence: {} }],
  created: 1,
  updated: 0,
  reopened: 0,
  resolved: 0,
  errors,
});

beforeEach(() => {
  mockRunTenant.mockReset();
  mockListTenants.mockReset();
  delete process.env.TRAVIS_ENABLED;
  delete process.env.TRAVIS_DRY_RUN;
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

test("apagado (interruptor): no lista tenants ni toca nada", async () => {
  expect(await handler()).toEqual({ enabled: false, tenants: 0, failed: 0 });
  expect(mockListTenants).not.toHaveBeenCalled();
});

test("solo corre con TRAVIS_ENABLED exactamente en 'true'", async () => {
  process.env.TRAVIS_ENABLED = "TRUE";
  expect((await handler()).enabled).toBe(false);
});

test("un negocio que lanza una excepción no frena a los demás", async () => {
  process.env.TRAVIS_ENABLED = "true";
  mockListTenants.mockResolvedValue([{ tenantId: "t1" }, { tenantId: "t2" }, { tenantId: "t3" }]);
  mockRunTenant.mockImplementation(async (tenant: { tenantId: string }) => {
    if (tenant.tenantId === "t2") throw new Error("boom");
    return result(tenant.tenantId);
  });

  expect(await handler()).toEqual({ enabled: true, tenants: 3, failed: 1 });
  expect(mockRunTenant).toHaveBeenCalledTimes(3);
});

test("cuenta como fallido al negocio que terminó con errores parciales", async () => {
  process.env.TRAVIS_ENABLED = "true";
  mockListTenants.mockResolvedValue([{ tenantId: "t1" }, { tenantId: "t2" }]);
  mockRunTenant.mockImplementation(async (tenant: { tenantId: string }) => result(tenant.tenantId, tenant.tenantId === "t1" ? ["análisis diario: x"] : []));

  expect((await handler()).failed).toBe(1);
});

test("no lanza aunque no pueda listar los negocios", async () => {
  process.env.TRAVIS_ENABLED = "true";
  mockListTenants.mockRejectedValue(new Error("dynamo caído"));

  expect(await handler()).toEqual({ enabled: true, tenants: 0, failed: 1 });
});

test("TRAVIS_DRY_RUN llega al runner y el log incluye lo que se habría guardado", async () => {
  process.env.TRAVIS_ENABLED = "true";
  process.env.TRAVIS_DRY_RUN = "true";
  mockListTenants.mockResolvedValue([{ tenantId: "t1" }]);
  mockRunTenant.mockResolvedValue({ ...result("t1"), dryRun: true });

  await handler();

  expect(mockRunTenant.mock.calls[0][2]).toEqual({ dryRun: true });
  const logged = JSON.parse((console.log as jest.Mock).mock.calls[0][0]);
  expect(logged.candidates).toEqual([{ detector: "agent_offline", scope: "branch:a1", severity: "warn", periodDate: "2026-11-04" }]);
});

test("fuera de dry-run el log no vuelca los candidatos", async () => {
  process.env.TRAVIS_ENABLED = "true";
  mockListTenants.mockResolvedValue([{ tenantId: "t1" }]);
  mockRunTenant.mockResolvedValue(result("t1"));

  await handler();

  expect(mockRunTenant.mock.calls[0][2]).toEqual({ dryRun: false });
  expect(JSON.parse((console.log as jest.Mock).mock.calls[0][0])).not.toHaveProperty("candidates");
});
