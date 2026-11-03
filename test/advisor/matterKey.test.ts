import { matterKey, matterSkPrefix } from "../../src/shared/dynamo";
import { isValidMatterScope } from "../../src/advisor/types";

describe("matterKey", () => {
  it("es determinista: el mismo día/detector/scope siempre cae en la misma clave", () => {
    const a = matterKey("t1", "2026-11-03", "sales_anomaly", "branch:abc");
    const b = matterKey("t1", "2026-11-03", "sales_anomaly", "branch:abc");
    expect(a).toEqual(b);
    expect(a).toEqual({ pk: "TENANT#t1", sk: "MATTER#2026-11-03#sales_anomaly#branch:abc" });
  });

  it("ordena por fecha local dentro del prefijo MATTER#", () => {
    const older = matterKey("t1", "2026-11-02", "agent_offline", "branch:a").sk;
    const newer = matterKey("t1", "2026-11-03", "agent_offline", "branch:a").sk;
    expect(older.startsWith(matterSkPrefix())).toBe(true);
    expect(older < newer).toBe(true);
  });
});

describe("isValidMatterScope", () => {
  it("acepta total y sucursales", () => {
    expect(isValidMatterScope("total")).toBe(true);
    expect(isValidMatterScope("branch:7f0c")).toBe(true);
  });

  it("rechaza vacío, demasiado largo o con el separador de la clave", () => {
    expect(isValidMatterScope("")).toBe(false);
    expect(isValidMatterScope("a#b")).toBe(false);
    expect(isValidMatterScope("x".repeat(81))).toBe(false);
  });
});
