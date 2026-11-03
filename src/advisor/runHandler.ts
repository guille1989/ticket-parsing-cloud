import { listAdvisorTenants } from "./opsData.js";
import { runTenant, type TenantRunResult } from "./runner.js";

/**
 * Lambda de Advisor: lo dispara EventBridge cada hora. `ADVISOR_ENABLED` es el interruptor de
 * apagado y `ADVISOR_DRY_RUN` calcula y registra lo que habría detectado sin guardar asuntos.
 * Los negocios se procesan de a uno: son pocos, y un error en uno no frena a los demás.
 * Nunca lanza una excepción: una invocación asíncrona fallida se reintenta sola, y repetir el
 * trabajo no aporta nada (los chequeos son idempotentes y se vuelven a correr en la hora siguiente).
 */
export async function handler(): Promise<{ enabled: boolean; tenants: number; failed: number }> {
  if (process.env.ADVISOR_ENABLED !== "true") {
    console.log(JSON.stringify({ advisor: "disabled" }));
    return { enabled: false, tenants: 0, failed: 0 };
  }
  const dryRun = process.env.ADVISOR_DRY_RUN === "true";
  const now = new Date();

  let tenants;
  try {
    tenants = await listAdvisorTenants();
  } catch (err) {
    console.error(JSON.stringify({ advisor: "error", stage: "listTenants", error: String(err) }));
    return { enabled: true, tenants: 0, failed: 1 };
  }

  let failed = 0;
  for (const tenant of tenants) {
    let result: TenantRunResult | undefined;
    try {
      result = await runTenant(tenant, now, { dryRun });
    } catch (err) {
      failed++;
      console.error(JSON.stringify({ advisor: "error", tenantId: tenant.tenantId, error: String(err) }));
      continue;
    }
    if (result.errors.length > 0) failed++;
    console.log(
      JSON.stringify({
        advisor: "tenant",
        tenantId: result.tenantId,
        dryRun: result.dryRun,
        ranDaily: result.ranDaily,
        ranHourly: result.ranHourly,
        created: result.created,
        updated: result.updated,
        reopened: result.reopened,
        resolved: result.resolved,
        errors: result.errors,
        // En dry-run se registra qué se habría guardado, para afinar umbrales antes de activarlo.
        ...(dryRun ? { candidates: result.candidates.map(({ detector, scope, severity, periodDate }) => ({ detector, scope, severity, periodDate })) } : {}),
      }),
    );
  }
  return { enabled: true, tenants: tenants.length, failed };
}
