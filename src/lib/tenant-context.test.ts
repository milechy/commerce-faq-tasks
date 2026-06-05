import { seedTenantsFromEnv, getTenantConfig, registerTenant, updateTenantEnabled } from "./tenant-context";

describe("seedTenantsFromEnv — numbered keys", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    // Save env vars we'll mutate
    for (const key of [
      "API_KEY",
      "API_KEY_TENANT_ID",
      "API_KEY_2",
      "API_KEY_2_TENANT_ID",
      "TENANT_CONFIGS_JSON",
    ]) {
      savedEnv[key] = process.env[key];
    }
  });

  afterAll(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it("reads API_KEY_TENANT_ID for the base key", () => {
    process.env.API_KEY = "test-key-base";
    process.env.API_KEY_TENANT_ID = "partner";
    delete process.env.TENANT_CONFIGS_JSON;

    seedTenantsFromEnv();

    const tenant = getTenantConfig("partner");
    expect(tenant).toBeDefined();
    expect(tenant?.tenantId).toBe("partner");
  });

  it("reads API_KEY_2 and API_KEY_2_TENANT_ID", () => {
    process.env.API_KEY_2 = "carnation-api-key-xxxx";
    process.env.API_KEY_2_TENANT_ID = "carnation";
    delete process.env.TENANT_CONFIGS_JSON;

    seedTenantsFromEnv();

    const tenant = getTenantConfig("carnation");
    expect(tenant).toBeDefined();
    expect(tenant?.tenantId).toBe("carnation");
  });
});

describe("updateTenantEnabled — kill-switch in-memory sync", () => {
  const TENANT_ID = "test-kill-switch-tenant";

  beforeEach(() => {
    registerTenant({
      tenantId: TENANT_ID,
      name: "Kill Switch Test",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: { apiKeyHash: "dummyhash", hashAlgorithm: "sha256", allowedOrigins: [], rateLimit: 100, rateLimitWindowMs: 60_000 },
      enabled: true,
    });
  });

  it("disables an existing tenant immediately", () => {
    const result = updateTenantEnabled(TENANT_ID, false);
    expect(result).toBe(true);
    expect(getTenantConfig(TENANT_ID)?.enabled).toBe(false);
  });

  it("re-enables a disabled tenant", () => {
    updateTenantEnabled(TENANT_ID, false);
    updateTenantEnabled(TENANT_ID, true);
    expect(getTenantConfig(TENANT_ID)?.enabled).toBe(true);
  });

  it("returns false for an unknown tenant (DB-only tenant)", () => {
    const result = updateTenantEnabled("non-existent-tenant-xyz", false);
    expect(result).toBe(false);
  });

  it("preserves other TenantConfig fields when updating enabled", () => {
    updateTenantEnabled(TENANT_ID, false);
    const cfg = getTenantConfig(TENANT_ID);
    expect(cfg?.name).toBe("Kill Switch Test");
    expect(cfg?.plan).toBe("starter");
    expect(cfg?.security.apiKeyHash).toBe("dummyhash");
  });
});
