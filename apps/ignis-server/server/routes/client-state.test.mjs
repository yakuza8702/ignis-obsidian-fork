import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const route = require("./client-state.js");
const { isAllowedKey } = route;

describe("client-state isAllowedKey", () => {
  it("accepts the fixed mirrored keys", () => {
    expect(isAllowedKey("last-vault")).toBe(true);
    expect(isAllowedKey("ignis-insecure-ack")).toBe(true);
  });

  it("accepts per-vault trust keys", () => {
    expect(isAllowedKey("enable-plugin-My Vault")).toBe(true);
    expect(isAllowedKey("enable-plugin-demo-abc__notes")).toBe(true);
  });

  it("rejects arbitrary keys", () => {
    expect(isAllowedKey("theme")).toBe(false);
    expect(isAllowedKey("enable-pluginx-vault")).toBe(false);
    expect(isAllowedKey("")).toBe(false);
    expect(isAllowedKey(null)).toBe(false);
    expect(isAllowedKey("a".repeat(129))).toBe(false);
  });
});
