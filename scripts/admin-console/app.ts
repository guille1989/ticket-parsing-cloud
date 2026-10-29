import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import { AdminError, type AdminData } from "./data.js";

const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const MAX_BODY_BYTES = 4 * 1024;

/**
 * Handler HTTP de la consola de operador. Solo escucha en 127.0.0.1 (ver
 * `server.ts`), pero igual se defiende de páginas web ajenas que intenten
 * hablarle a localhost desde el navegador del operador:
 *  - `Host` tiene que ser localhost/127.0.0.1 (evita DNS rebinding);
 *  - los POST exigen `Origin` propio y `Content-Type: application/json`, que
 *    un formulario de otro sitio no puede mandar sin preflight.
 */
export function createApp(data: AdminData, port: number, htmlPath: string) {
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);

  function send(res: ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8") {
    res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  }

  function readJson(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new AdminError(413, "body demasiado grande"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
        } catch {
          reject(new AdminError(400, "body inválido"));
        }
      });
      req.on("error", reject);
    });
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const host = req.headers.host ?? "";
      if (!allowedHosts.has(host)) throw new AdminError(403, "host no permitido");

      const method = req.method ?? "GET";
      if (method !== "GET") {
        if (req.headers.origin !== `http://${host}`) throw new AdminError(403, "origen no permitido");
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new AdminError(415, "se espera application/json");
      }

      const path = new URL(req.url ?? "/", `http://${host}`).pathname;

      if (method === "GET" && path === "/") {
        return send(res, 200, readFileSync(htmlPath, "utf8"), "text/html; charset=utf-8");
      }
      if (method === "GET" && path === "/api/catalog") return send(res, 200, { catalog: data.catalog });
      if (method === "GET" && path === "/api/tenants") return send(res, 200, { tenants: await data.listTenants() });

      const agents = /^\/api\/tenants\/([^/]+)\/agents$/.exec(path);
      if (agents && method === "GET") {
        const [, tenantId] = agents;
        assertId(tenantId);
        return send(res, 200, { agents: await data.listAgents(tenantId) });
      }

      const commands = /^\/api\/tenants\/([^/]+)\/agents\/([^/]+)\/commands$/.exec(path);
      if (commands) {
        const [, tenantId, agentId] = commands;
        assertId(tenantId);
        assertId(agentId);
        if (method === "GET") return send(res, 200, { commands: await data.listCommands(tenantId, agentId) });
        if (method === "POST") {
          const body = (await readJson(req)) as { scriptId?: unknown };
          return send(res, 202, { command: await data.createCommand(tenantId, agentId, body.scriptId) });
        }
      }

      throw new AdminError(404, "no encontrado");
    } catch (err) {
      if (err instanceof AdminError) return send(res, err.status, { error: err.message });
      console.error("[admin] error inesperado:", err);
      return send(res, 500, { error: "error interno (ver la consola del servidor)" });
    }
  };
}

function assertId(value: string | undefined): asserts value is string {
  if (!value || !ID_PATTERN.test(value)) throw new AdminError(400, "id inválido");
}
