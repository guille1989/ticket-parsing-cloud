import { request, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { createApp } from "../../scripts/admin-console/app";
import { AdminError, createAdminData, pickOne, versionAtLeast } from "../../scripts/admin-console/data";

const send = jest.fn();
const ddb = { send: (...args: unknown[]) => send(...args) } as unknown as DynamoDBDocumentClient;
const NOW = new Date("2026-10-29T12:00:00Z");
const data = createAdminData(ddb, { agents: "Agents", tenants: "Tenants" }, () => NOW);

beforeEach(() => send.mockReset());

describe("versionAtLeast", () => {
  test.each([
    ["0.5.0", true], ["0.5.1", true], ["0.10.0", true], ["1.0.0", true],
    ["0.4.0", false], ["0.4.9", false], [undefined, false],
  ])("%s >= 0.5.0 → %s", (version, expected) => {
    expect(versionAtLeast(version, "0.5.0")).toBe(expected);
  });
});

describe("pickOne", () => {
  const tenants = [
    { id: "c66340d5-aaaa", name: "Hotel la Plazuela" },
    { id: "de728d42-bbbb", name: "Empanadas Típicas" },
    { id: "d3a10000-cccc", name: "Horno Castizo (DEMO)" },
  ];
  const pick = (q: string) => pickOne(tenants, q, (t) => t.id, (t) => t.name, "negocios");

  test("por parte del nombre, sin importar mayúsculas ni acentos", () => {
    expect(pick("tipicas").id).toBe("de728d42-bbbb");
    expect(pick("HOTEL").id).toBe("c66340d5-aaaa");
  });
  test("por prefijo de id", () => expect(pick("d3a1").name).toContain("Horno"));
  test("ambiguo o inexistente falla listando opciones", () => {
    expect(() => pick("h")).toThrow(/varios negocios/);
    expect(() => pick("zzz")).toThrow(/ningún negocios|ningún negocio/);
    expect(() => pick("zzz")).toThrow(AdminError);
  });
});

describe("datos", () => {
  test("listAgents marca en línea y si entiende diagnósticos", async () => {
    send.mockResolvedValueOnce({
      Items: [
        { agentId: "a1", name: "Caja 1", version: "0.5.0", lastSeenAt: "2026-10-29T11:59:30Z" },
        { agentId: "a2", name: "Caja 2", version: "0.4.0", lastSeenAt: "2026-10-29T08:00:00Z" },
      ],
    });
    const agents = await data.listAgents("t1");
    expect(agents).toMatchObject([
      { agentId: "a1", online: true, canDiagnose: true },
      { agentId: "a2", online: false, canDiagnose: false },
    ]);
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues).toEqual({ ":pk": "TENANT#t1", ":prefix": "AGENT#" });
  });

  test("createCommand crea un pending con TTL en la clave CMD# del agente", async () => {
    send.mockResolvedValueOnce({ Item: {} }).mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({});

    const command = await data.createCommand("t1", "a1", "printers");

    expect(command).toMatchObject({ tenantId: "t1", agentId: "a1", scriptId: "printers", status: "pending", createdAt: NOW.toISOString() });
    const put = send.mock.calls[2][0].input;
    expect(put.TableName).toBe("Agents");
    expect(put.Item.pk).toBe("TENANT#t1");
    expect(put.Item.sk).toMatch(/^CMD#a1#\d{13}-[0-9a-f]{6}$/);
    expect(put.Item.ttl).toBe(Math.floor(NOW.getTime() / 1000) + 30 * 24 * 3600);
  });

  test("createCommand rechaza scripts fuera del catálogo sin tocar la base", async () => {
    await expect(data.createCommand("t1", "a1", "Remove-Item C:\\ -Recurse")).rejects.toMatchObject({ status: 400 });
    expect(send).not.toHaveBeenCalled();
  });

  test("createCommand: 404 si el agente no existe y 429 con demasiados abiertos", async () => {
    send.mockResolvedValueOnce({});
    await expect(data.createCommand("t1", "nadie", "network")).rejects.toMatchObject({ status: 404 });

    const recent = NOW.toISOString();
    send
      .mockResolvedValueOnce({ Item: {} })
      .mockResolvedValueOnce({ Items: Array.from({ length: 5 }, (_, i) => ({ status: "pending", createdAt: recent, commandId: `c${i}` })) });
    await expect(data.createCommand("t1", "a1", "network")).rejects.toMatchObject({ status: 429 });
  });
});

describe("servidor local", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    // El puerto se conoce recién al escuchar, y el handler lo necesita para validar Host.
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    handler = createApp(data, port, join(__dirname, "../../scripts/admin-console/index.html"));
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  let handler: ReturnType<typeof createApp>;

  function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request({ host: "127.0.0.1", port, method, path, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", reject);
      req.end(payload);
    });
  }

  test("sirve la página y la API en localhost", async () => {
    send.mockResolvedValueOnce({ Items: [{ tenantId: "t1", businessName: "Hotel", createdAt: "2026-01-01" }] });
    expect((await call("GET", "/")).body).toContain("Consola de operador");
    const tenants = await call("GET", "/api/tenants");
    expect(tenants.status).toBe(200);
    expect(JSON.parse(tenants.body).tenants[0]).toMatchObject({ tenantId: "t1", businessName: "Hotel", status: "active" });
  });

  test("rechaza un Host que no es localhost (DNS rebinding)", async () => {
    expect((await call("GET", "/api/tenants", { Host: "evil.example.com" })).status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  test("POST exige origen propio y JSON (CSRF desde otra página)", async () => {
    const url = "/api/tenants/t1/agents/a1/commands";
    const json = { "Content-Type": "application/json" };
    expect((await call("POST", url, json, { scriptId: "printers" })).status).toBe(403); // sin Origin
    expect((await call("POST", url, { ...json, Origin: "http://evil.example.com" }, { scriptId: "printers" })).status).toBe(403);
    expect((await call("POST", url, { Origin: `http://localhost:${port}`, "Content-Type": "text/plain" }, { scriptId: "printers" })).status).toBe(415);
    expect(send).not.toHaveBeenCalled();
  });

  test("POST válido crea el pedido y devuelve 202", async () => {
    send.mockResolvedValueOnce({ Item: {} }).mockResolvedValueOnce({ Items: [] }).mockResolvedValueOnce({});
    const res = await call("POST", "/api/tenants/t1/agents/a1/commands", { Origin: `http://localhost:${port}`, "Content-Type": "application/json" }, { scriptId: "network" });
    expect(res.status).toBe(202);
    expect(JSON.parse(res.body).command).toMatchObject({ scriptId: "network", status: "pending" });
  });

  test("valida los ids del path y responde 404 a lo desconocido", async () => {
    expect((await call("GET", "/api/tenants/..%2F..%2Fx/agents")).status).toBe(400);
    expect((await call("GET", "/api/nada")).status).toBe(404);
  });
});
