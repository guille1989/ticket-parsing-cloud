import type { APIGatewayProxyWithCognitoAuthorizerEvent } from "aws-lambda";

import { createFakeDynamo } from "./fakeDynamo";

const fake = createFakeDynamo();

// La autorización se verifica con el helper real en shared/humanAuthorization.test.ts.
jest.mock("../../src/shared/auth", () => ({
  resolveActiveTenantIdFromEvent: jest.fn(async (event: APIGatewayProxyWithCognitoAuthorizerEvent) =>
    event.requestContext?.authorizer?.claims?.["custom:tenantId"]),
}));

jest.mock("../../src/shared/dynamo", () => {
  const actual = jest.requireActual("../../src/shared/dynamo");
  return { ...actual, ddb: { send: (...args: unknown[]) => fake.send(args[0]) }, MATTERS_TABLE: "TestMatters", AGENTS_TABLE: "TestAgents" };
});

import { publicMatterId, internalMatterId } from "../../src/travis/matterApi";
import { upsertMatters } from "../../src/travis/matterStore";
import { handler as listHandler } from "../../src/travis/mattersListHandler";
import { handler as updateHandler } from "../../src/travis/mattersUpdateHandler";
import type { MatterCandidate } from "../../src/travis/types";

function event(options: { tenant?: string | null; query?: Record<string, string>; matterId?: string; body?: unknown } = {}): APIGatewayProxyWithCognitoAuthorizerEvent {
  const { tenant = "t1", query, matterId, body } = options;
  return {
    requestContext: { authorizer: { claims: tenant ? { "custom:tenantId": tenant } : {} } },
    queryStringParameters: query ?? null,
    pathParameters: matterId ? { matterId } : null,
    body: body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body),
  } as unknown as APIGatewayProxyWithCognitoAuthorizerEvent;
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

function matter(overrides: Partial<MatterCandidate> = {}): MatterCandidate {
  return { detector: "agent_offline", scope: "branch:a1", periodDate: today(), severity: "warn", evidence: { agentName: "Caja 1" }, ...overrides };
}

const idOf = (candidate: MatterCandidate) => publicMatterId(candidate);
const body = (result: { body: string }) => JSON.parse(result.body);

beforeEach(() => {
  fake.items.clear();
  fake.items.set("TENANT#t1|AGENT#a1", { pk: "TENANT#t1", sk: "AGENT#a1", agentId: "a1", name: "Caja 1", location: { label: "Sede Norte" } });
});

describe("id público", () => {
  it("viaja en base64url (sin # ni :, que API Gateway no decodifica) y vuelve al id interno", () => {
    const id = idOf(matter());
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(internalMatterId(id)).toBe(`${today()}#agent_offline#branch:a1`);
  });

  it("rechaza ids que no son de un asunto", () => {
    expect(internalMatterId("no es base64!")).toBeNull();
    expect(internalMatterId(Buffer.from("cualquier cosa").toString("base64url"))).toBeNull();
    expect(internalMatterId("")).toBeNull();
  });
});

describe("GET /travis/matters", () => {
  it("sin sesión: 403", async () => {
    expect((await listHandler(event({ tenant: null }))).statusCode).toBe(403);
  });

  it("devuelve los asuntos sin claves internas, con el nombre de la sucursal y el contador de nuevos", async () => {
    await upsertMatters("t1", [matter()]);

    const result = await listHandler(event());

    expect(result.statusCode).toBe(200);
    const { matters, newCount } = body(result);
    expect(newCount).toBe(1);
    expect(matters).toEqual([
      expect.objectContaining({
        id: idOf(matter()),
        detector: "agent_offline",
        scope: "branch:a1",
        branchLabel: "Sede Norte",
        severity: "warn",
        status: "new",
        expected: null,
        actual: null,
        seenAt: null,
        evidence: { agentName: "Caja 1" },
      }),
    ]);
    for (const hidden of ["pk", "sk", "ttl", "tenantId"]) expect(matters[0]).not.toHaveProperty(hidden);
  });

  it("el día más reciente primero y, dentro de un día, lo más grave primero", async () => {
    await upsertMatters("t1", [
      matter({ periodDate: daysAgo(1), detector: "review_backlog", scope: "total", severity: "critical" }),
      matter({ detector: "review_backlog", scope: "total", severity: "info" }),
      matter({ severity: "critical" }),
    ]);

    const { matters } = body(await listHandler(event()));

    expect(matters.map((m: { periodDate: string; severity: string }) => `${m.periodDate === today() ? "hoy" : "ayer"}:${m.severity}`)).toEqual([
      "hoy:critical",
      "hoy:info",
      "ayer:critical",
    ]);
  });

  it("?days acota el rango y un valor basura cae al de 14 días", async () => {
    await upsertMatters("t1", [matter({ periodDate: daysAgo(10), scope: "total" }), matter({ scope: "total" })]);

    expect(body(await listHandler(event({ query: { days: "3" } }))).matters).toHaveLength(1);
    expect(body(await listHandler(event({ query: { days: "abc" } }))).matters).toHaveLength(2);
    expect(body(await listHandler(event({ query: { days: "-5" } }))).matters).toHaveLength(2);
  });

  it("?status filtra, pero newCount sigue contando todos los nuevos", async () => {
    await upsertMatters("t1", [matter({ scope: "total" }), matter({ detector: "capture_zero" })]);
    await updateHandler(event({ matterId: idOf(matter({ scope: "total" })), body: { status: "dismissed" } }));

    const { matters, newCount } = body(await listHandler(event({ query: { status: "new,seen" } })));

    expect(matters).toHaveLength(1);
    expect(matters[0].detector).toBe("capture_zero");
    expect(newCount).toBe(1);
  });

  it("un status inválido es 400", async () => {
    expect((await listHandler(event({ query: { status: "new,otro" } }))).statusCode).toBe(400);
  });

  it("aislamiento: no ve los asuntos de otro negocio, ni el perfil de hábitos", async () => {
    await upsertMatters("otro", [matter()]);
    fake.items.set("TENANT#t1|PROFILE#habits", { pk: "TENANT#t1", sk: "PROFILE#habits", habits: {} });

    const { matters } = body(await listHandler(event()));

    expect(matters).toEqual([]);
  });
});

describe("PATCH /travis/matters/{matterId}", () => {
  it("sin sesión: 403", async () => {
    expect((await updateHandler(event({ tenant: null, matterId: idOf(matter()), body: { status: "seen" } }))).statusCode).toBe(403);
  });

  it("marca como visto y luego descartado, y devuelve el asunto actualizado", async () => {
    await upsertMatters("t1", [matter()]);

    const seen = await updateHandler(event({ matterId: idOf(matter()), body: { status: "seen" } }));
    const dismissed = await updateHandler(event({ matterId: idOf(matter()), body: { status: "dismissed" } }));

    expect(seen.statusCode).toBe(200);
    expect(body(seen).matter).toMatchObject({ status: "seen", branchLabel: "Sede Norte" });
    expect(body(seen).matter.seenAt).not.toBeNull();
    expect(body(dismissed).matter.status).toBe("dismissed");
  });

  it("un id mal formado o inexistente es 404", async () => {
    expect((await updateHandler(event({ matterId: "basura!", body: { status: "seen" } }))).statusCode).toBe(404);
    expect((await updateHandler(event({ body: { status: "seen" } }))).statusCode).toBe(404);
    expect((await updateHandler(event({ matterId: idOf(matter()), body: { status: "seen" } }))).statusCode).toBe(404);
  });

  it("aislamiento: no puede marcar el asunto de otro negocio", async () => {
    await upsertMatters("otro", [matter()]);

    const result = await updateHandler(event({ matterId: idOf(matter()), body: { status: "dismissed" } }));

    expect(result.statusCode).toBe(404);
    expect(fake.get("TENANT#otro", `MATTER#${today()}#agent_offline#branch:a1`)?.status).toBe("new");
  });

  it("un asunto que se resolvió solo es 409", async () => {
    await upsertMatters("t1", [matter()]);
    fake.get("TENANT#t1", `MATTER#${today()}#agent_offline#branch:a1`)!.status = "resolved";

    expect((await updateHandler(event({ matterId: idOf(matter()), body: { status: "seen" } }))).statusCode).toBe(409);
  });

  it("valida el body: JSON roto, sin status o con un status que el dueño no puede poner", async () => {
    await upsertMatters("t1", [matter()]);
    const id = idOf(matter());

    expect((await updateHandler(event({ matterId: id, body: "{no es json" }))).statusCode).toBe(400);
    expect((await updateHandler(event({ matterId: id }))).statusCode).toBe(400);
    expect((await updateHandler(event({ matterId: id, body: { status: "resolved" } }))).statusCode).toBe(400);
    expect((await updateHandler(event({ matterId: id, body: { status: "new" } }))).statusCode).toBe(400);
  });
});
