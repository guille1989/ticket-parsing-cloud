import { resolveDesiredVersion } from "../../src/agents/otaPolicy";

test("resolveDesiredVersion: override del agent gana sobre la global", () => {
  expect(resolveDesiredVersion("0.5.2", "0.5.1")).toBe("0.5.2");
});

test("resolveDesiredVersion: sin override hereda la global", () => {
  expect(resolveDesiredVersion(undefined, "0.5.1")).toBe("0.5.1");
  expect(resolveDesiredVersion("  ", "0.5.1")).toBe("0.5.1");
});

test("resolveDesiredVersion: sin global ni override = sin OTA", () => {
  expect(resolveDesiredVersion(undefined, undefined)).toBeUndefined();
  expect(resolveDesiredVersion("", "")).toBeUndefined();
});
