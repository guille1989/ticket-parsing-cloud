import type { PreAuthenticationTriggerEvent } from "aws-lambda";

const mockGetTenant = jest.fn();

jest.mock("../../src/shared/tenant", () => ({
  getTenant: (...args: unknown[]) => mockGetTenant(...args),
}));

import { handler } from "../../src/tenants/preAuthHandler";

function event(tenantId?: string): PreAuthenticationTriggerEvent {
  return {
    request: { userAttributes: tenantId ? { "custom:tenantId": tenantId } : {} },
  } as unknown as PreAuthenticationTriggerEvent;
}

beforeEach(() => {
  mockGetTenant.mockReset();
});

test("tenant activo: deja pasar el login (devuelve el evento tal cual)", async () => {
  mockGetTenant.mockResolvedValue({ status: "active" });
  const e = event("t1");

  const result = await handler(e);

  expect(result).toBe(e);
});

test("tenant sin status (tenants viejos, antes de que existiera el campo): deja pasar", async () => {
  mockGetTenant.mockResolvedValue({ tenantId: "t1" });
  await expect(handler(event("t1"))).resolves.toBeDefined();
});

test("tenant bloqueado: corta el login tirando una excepción", async () => {
  mockGetTenant.mockResolvedValue({ status: "blocked" });
  await expect(handler(event("t1"))).rejects.toThrow(/bloqueada/);
});

test("sin custom:tenantId en el evento: no revienta, deja pasar (no debería pasar en la práctica)", async () => {
  await expect(handler(event(undefined))).resolves.toBeDefined();
  expect(mockGetTenant).not.toHaveBeenCalled();
});
