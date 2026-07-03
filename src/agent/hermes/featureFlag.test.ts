// src/agent/hermes/featureFlag.test.ts
// Phase74: Hermes Agent Feature Flag テスト

import {
  isHermesTenantAllowed,
  isHermesEnabled,
  isHermesNotifyEnabled,
  isHermesLlmEnabled,
} from "./featureFlag";

const ENV_KEYS = [
  "HERMES_ENABLED",
  "HERMES_TENANTS",
  "HERMES_NOTIFY_ENABLED",
  "HERMES_LLM_ENABLED",
] as const;

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("isHermesEnabled", () => {
  it("未設定なら false", () => {
    expect(isHermesEnabled()).toBe(false);
  });

  it("'true' で true", () => {
    process.env.HERMES_ENABLED = "true";
    expect(isHermesEnabled()).toBe(true);
  });
});

describe("isHermesTenantAllowed", () => {
  it("対象テナントのみ true", () => {
    process.env.HERMES_TENANTS = "carnation";
    expect(isHermesTenantAllowed("carnation")).toBe(true);
    expect(isHermesTenantAllowed("other")).toBe(false);
  });

  it("'*' で全テナント true", () => {
    process.env.HERMES_TENANTS = "*";
    expect(isHermesTenantAllowed("anyone")).toBe(true);
  });

  it("未設定なら常に false", () => {
    expect(isHermesTenantAllowed("carnation")).toBe(false);
  });
});

describe("isHermesNotifyEnabled", () => {
  it("既定 true", () => {
    expect(isHermesNotifyEnabled()).toBe(true);
  });

  it("'false' 明示で false", () => {
    process.env.HERMES_NOTIFY_ENABLED = "false";
    expect(isHermesNotifyEnabled()).toBe(false);
  });
});

describe("isHermesLlmEnabled", () => {
  it("既定 false", () => {
    expect(isHermesLlmEnabled()).toBe(false);
  });

  it("'true' で true", () => {
    process.env.HERMES_LLM_ENABLED = "true";
    expect(isHermesLlmEnabled()).toBe(true);
  });
});
