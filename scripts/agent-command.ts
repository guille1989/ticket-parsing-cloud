// Pide un diagnóstico de solo lectura a un agente y espera su resultado — la
// versión de terminal de `npm run admin`. Escribe directo en la tabla Agents
// con las credenciales de AWS de quien lo corre.
//
// Uso (desde ticket-parsing-cloud/):
//   npm run agent-command                                  # lista negocios y agentes
//   npm run agent-command -- <negocio> <agente> <script>   # negocio/agente: id, prefijo o parte del nombre
//   npm run agent-command -- empanadas "caja 1" printers
//   opciones: --no-wait (solo encola)   --timeout 120 (segundos de espera)
// Scripts: agent-health, printers, spooler, network, agent-logs, agent-state
import { AdminError, pickOne } from "./admin-console/data.js";
import { connectAdminData } from "./admin-console/aws.js";

const ago = (iso?: string) => {
  if (!iso) return "nunca";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 90 ? `hace ${s} s` : s < 5400 ? `hace ${Math.round(s / 60)} min` : s < 129600 ? `hace ${Math.round(s / 3600)} h` : `hace ${Math.round(s / 86400)} d`;
};

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const noWait = process.argv.includes("--no-wait");
  const timeoutIndex = process.argv.indexOf("--timeout");
  const timeoutMs = (Number(timeoutIndex >= 0 ? process.argv[timeoutIndex + 1] : undefined) || 120) * 1000;
  const data = connectAdminData();

  if (args.length === 0) {
    for (const tenant of await data.listTenants()) {
      console.log(`${tenant.businessName}  [${tenant.status}]  ${tenant.tenantId}`);
      for (const agent of await data.listAgents(tenant.tenantId)) {
        const flag = agent.online ? "● en línea" : `○ visto ${ago(agent.lastSeenAt)}`;
        console.log(`    ${agent.name.padEnd(24)} v${(agent.version ?? "?").padEnd(8)} ${flag}${agent.canDiagnose ? "" : "   (sin diagnósticos: requiere v0.5.0)"}`);
      }
    }
    console.log(`\nScripts: ${Object.keys(data.catalog).join(", ")}`);
    return;
  }

  const [tenantQuery, agentQuery, scriptId] = args;
  if (!tenantQuery || !agentQuery || !scriptId) throw new AdminError(400, "uso: agent-command <negocio> <agente> <script>");

  const tenant = pickOne(await data.listTenants(), tenantQuery, (t) => t.tenantId, (t) => t.businessName, "negocios");
  const agent = pickOne(await data.listAgents(tenant.tenantId), agentQuery, (a) => a.agentId, (a) => a.name, "agentes");
  if (!agent.canDiagnose) throw new AdminError(409, `${agent.name} es v${agent.version ?? "?"}: aún no entiende diagnósticos (requiere v0.5.0)`);
  if (!agent.online) console.warn(`Aviso: ${agent.name} no da señales ${ago(agent.lastSeenAt)}; el pedido caduca a los 15 min.`);

  const command = await data.createCommand(tenant.tenantId, agent.agentId, scriptId);
  console.log(`Pedido ${command.commandId} (${scriptId}) para ${agent.name} de ${tenant.businessName}.`);
  if (noWait) return;

  console.log("Esperando al agente (llega en su próximo heartbeat, hasta ~1 min)…");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const current = await data.getCommand(tenant.tenantId, agent.agentId, command.commandId);
    if (current && (current.status === "done" || current.status === "failed")) {
      console.log(`\n── ${scriptId}: ${current.status === "done" ? "OK" : "FALLÓ"} (exit ${current.exitCode}, ${current.durationMs} ms) ──\n`);
      console.log(current.stdout || "(sin salida)");
      if (current.stderr) console.error(`\n── stderr ──\n${current.stderr}`);
      process.exitCode = current.status === "done" ? 0 : 1;
      return;
    }
  }
  console.error("\nTiempo de espera agotado: el agente no respondió. Puedes ver el resultado después en `npm run admin`.");
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(err instanceof AdminError ? err.message : err);
  process.exit(1);
});
