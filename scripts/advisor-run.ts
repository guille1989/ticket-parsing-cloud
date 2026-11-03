// Corrida en seco de Advisor desde tu PC contra los datos reales de AWS (solo lectura: no escribe
// asuntos ni el perfil de hábitos). Sirve para ver qué detectaría y afinar umbrales ANTES de
// activar el job. Siempre hace el análisis diario completo (una consulta Athena por negocio).
//
// Uso (desde ticket-parsing-cloud/):
//   npm run advisor-run                          # todos los negocios activos
//   npm run advisor-run -- --tenant <tenantId>   # uno solo
//   opciones: --now 2026-11-03T12:00:00Z        # simular otra hora (cambia qué día es "ayer")
import { readStackOutputs, requireOutput } from "./lib/stackOutputs.js";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const outputs = readStackOutputs();
  const need = (name: string) => requireOutput(outputs, name);
  // Las tablas y el workgroup se leen al importar los módulos: hay que fijarlos antes del import.
  process.env.AWS_REGION ??= "us-east-1";
  process.env.TENANTS_TABLE = need("TenantsTableName");
  process.env.TICKETS_TABLE = need("TicketsTableName");
  process.env.AGENTS_TABLE = need("AgentsTableName");
  process.env.ATHENA_WORKGROUP = need("AthenaWorkGroupName");

  const { listAdvisorTenants } = await import("../src/advisor/opsData.js");
  const { realDeps, runTenant } = await import("../src/advisor/runner.js");
  // La tabla Matters puede no estar desplegada todavía: el perfil de hábitos no se lee ni se escribe.
  const deps = { ...realDeps, loadHabitProfile: async () => undefined, saveHabitProfile: async () => undefined };

  const onlyTenant = argValue("tenant");
  const now = argValue("now") ? new Date(argValue("now")!) : new Date();
  const tenants = (await listAdvisorTenants()).filter((tenant) => !onlyTenant || tenant.tenantId === onlyTenant);
  if (tenants.length === 0) throw new Error("no hay negocios que revisar");

  for (const tenant of tenants) {
    const result = await runTenant(tenant, now, { dryRun: true, forceDaily: true }, deps);
    console.log(`\n== ${result.businessName} (${result.tenantId}) · ${result.timeZone} · ${now.toISOString()}`);
    if (result.errors.length > 0) console.log("   ERRORES:", result.errors.join(" | "));
    console.log(`   análisis diario: ${result.ranDaily ? "ok" : "no"} · chequeos horarios: ${result.ranHourly ? "ok" : "no"} · asuntos que se habrían guardado: ${result.candidates.length}`);
    for (const c of result.candidates) {
      console.log(`   - [${c.severity}] ${c.detector} ${c.scope} ${c.periodDate} esperado=${c.expected ?? "-"} real=${c.actual ?? "-"} ${JSON.stringify(c.evidence)}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
