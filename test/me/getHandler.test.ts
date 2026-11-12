import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

const mockGetTenant = jest.fn();

jest.mock("../../src/shared/tenant", () => ({ getTenant: (...args: unknown[]) => mockGetTenant(...args) }));

import { handler } from "../../src/me/getHandler";

function eventWith(tenantId?: string): APIGatewayProxyWithCognitoAuthorizerEvent {
  return { requestContext: { authorizer: { claims: tenantId ? { "custom:tenantId": tenantId } : {} } } } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;
}

beforeEach(() => mockGetTenant.mockReset());

test("rechaza una petición sin tenant autenticado", async () => {
  const result = await handler(eventWith());
  expect(result.statusCode).toBe(403);
  expect(mockGetTenant).not.toHaveBeenCalled();
});

test("devuelve el perfil público y el onboarding", async () => {
  mockGetTenant.mockResolvedValue({ tenantId: "t1", businessName: "Café Uno", createdAt: "2026-08-12T10:00:00.000Z", parserId: "p1", onboarding: { version: 1 } });
  const result = await handler(eventWith("t1"));
  expect(JSON.parse(result.body)).toEqual({
    tenantId: "t1", businessName: "Café Uno", createdAt: "2026-08-12T10:00:00.000Z", onboarding: { version: 1 }, profile: null, features: { advisorView: false }, timeZone: null,
  });
  expect(result.body).not.toContain("parserId");
});

test("incluye la ficha de negocio cuando existe", async () => {
  mockGetTenant.mockResolvedValue({
    tenantId: "t1",
    businessName: "Café Uno",
    createdAt: "2026-08-12T10:00:00.000Z",
    profile: { currency: "COP", industry: "restaurante", openingHours: { default: { open: "08:00", close: "20:00" } } },
  });
  const body = JSON.parse((await handler(eventWith("t1"))).body);
  expect(body.profile).toEqual({
    currency: "COP",
    industry: "restaurante",
    openingHours: { default: { open: "08:00", close: "20:00" } },
  });
});

test("la vista beta del asistente solo se enciende con betaView exactamente en true", async () => {
  const base = { tenantId: "t1", businessName: "Café Uno", createdAt: "2026-08-12T10:00:00.000Z" };
  const advisorView = async (advisor?: Record<string, unknown>) => {
    mockGetTenant.mockResolvedValue({ ...base, ...(advisor ? { advisor } : {}) });
    return JSON.parse((await handler(eventWith("t1"))).body).features.advisorView;
  };
  expect(await advisorView()).toBe(false);
  expect(await advisorView({ timeZone: "America/Bogota" })).toBe(false);
  expect(await advisorView({ betaView: false })).toBe(false);
  expect(await advisorView({ betaView: "true" })).toBe(false);
  expect(await advisorView({ betaView: true })).toBe(true);
});

test("expone la zona del negocio y oculta el resto de ajustes del asesor", async () => {
  mockGetTenant.mockResolvedValue({ tenantId: "t1", businessName: "Café Uno", createdAt: "x", advisor: { betaView: true, notifyEmails: ["dueno@correo.com"], timeZone: "America/Bogota" } });
  const body = JSON.parse((await handler(eventWith("t1"))).body);
  expect(body.timeZone).toBe("America/Bogota");
  expect(body.features.advisorView).toBe(true);
  expect(JSON.stringify(body)).not.toContain("dueno@correo.com");
  expect(body).not.toHaveProperty("notifyEmails");
  expect(body).not.toHaveProperty("briefingHour");
});

test.each([
  ["sin advisor", undefined],
  ["advisor sin zona", {}],
  ["zona inválida", { timeZone: "Marte/Olympus" }],
])("sin zona utilizable (%s): timeZone null", async (_caso, advisor) => {
  mockGetTenant.mockResolvedValue({ tenantId: "t1", businessName: "Café Uno", createdAt: "x", ...(advisor ? { advisor } : {}) });
  expect(JSON.parse((await handler(eventWith("t1"))).body).timeZone).toBeNull();
});

test("un tenant anterior devuelve onboarding null", async () => {
  mockGetTenant.mockResolvedValue({ tenantId: "legacy", businessName: "Anterior", createdAt: "2026-01-01T00:00:00.000Z", parserId: "p1" });
  const result = await handler(eventWith("legacy"));
  expect(JSON.parse(result.body).onboarding).toBeNull();
});
