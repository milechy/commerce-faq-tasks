import {
  seedTenantsFromEnv,
  getTenantConfig,
  registerTenant,
  updateTenantEnabled,
  isOriginKnownToAnyTenant,
  getTenantByApiKeyHash,
  setTenantApiKeyExpiry,
  revokeTenantApiKeyIfCurrent,
} from "./tenant-context";

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

describe("isOriginKnownToAnyTenant — CORS preflight tenant-domain lookup", () => {
  beforeEach(() => {
    registerTenant({
      tenantId: "origin-test-tenant",
      name: "Origin Test Tenant",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: {
        apiKeyHash: "dummyhash-origin",
        hashAlgorithm: "sha256",
        allowedOrigins: ["https://shop.example.com", "https://*.wildcard-shop.com"],
        rateLimit: 100,
        rateLimitWindowMs: 60_000,
      },
      enabled: true,
    });
  });

  it("returns true for an origin registered on a tenant", () => {
    expect(isOriginKnownToAnyTenant("https://shop.example.com")).toBe(true);
  });

  it("returns true for an origin matching a tenant's wildcard pattern", () => {
    expect(isOriginKnownToAnyTenant("https://sub.wildcard-shop.com")).toBe(true);
  });

  it("returns false for an origin not registered on any tenant", () => {
    expect(isOriginKnownToAnyTenant("https://unregistered-domain.example")).toBe(false);
  });

  it("returns false when checked against a tenant with no allowedOrigins", () => {
    registerTenant({
      tenantId: "no-origin-tenant",
      name: "No Origin Tenant",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: { apiKeyHash: "dummyhash-2", hashAlgorithm: "sha256", allowedOrigins: [], rateLimit: 100, rateLimitWindowMs: 60_000 },
      enabled: true,
    });
    expect(isOriginKnownToAnyTenant("https://some-random-site.example")).toBe(false);
  });
});

describe("APIキー失効・期限切れの即時反映", () => {
  const TENANT_ID = "test-key-revocation-tenant";
  const KEY_HASH = "revocation-test-key-hash";

  beforeEach(() => {
    registerTenant({
      tenantId: TENANT_ID,
      name: "Revocation Test",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: { apiKeyHash: KEY_HASH, hashAlgorithm: "sha256", allowedOrigins: [], rateLimit: 100, rateLimitWindowMs: 60_000 },
      enabled: true,
    });
    setTenantApiKeyExpiry(TENANT_ID, null);
  });

  it("finds the tenant by the currently registered key hash", () => {
    expect(getTenantByApiKeyHash(KEY_HASH)?.tenantId).toBe(TENANT_ID);
  });

  it("revokeTenantApiKeyIfCurrent invalidates a matching key immediately (no PM2 restart needed)", () => {
    const revoked = revokeTenantApiKeyIfCurrent(TENANT_ID, KEY_HASH);
    expect(revoked).toBe(true);
    expect(getTenantByApiKeyHash(KEY_HASH)).toBeUndefined();
  });

  it("revokeTenantApiKeyIfCurrent does nothing when the hash does not match the current key (e.g. an already-superseded key)", () => {
    const revoked = revokeTenantApiKeyIfCurrent(TENANT_ID, "some-other-old-key-hash");
    expect(revoked).toBe(false);
    expect(getTenantByApiKeyHash(KEY_HASH)?.tenantId).toBe(TENANT_ID);
  });

  it("revokeTenantApiKeyIfCurrent returns false for an unknown tenant", () => {
    expect(revokeTenantApiKeyIfCurrent("unknown-tenant-xyz", KEY_HASH)).toBe(false);
  });

  it("treats a key as expired once its expiry time has passed", () => {
    setTenantApiKeyExpiry(TENANT_ID, new Date(Date.now() - 1000));
    expect(getTenantByApiKeyHash(KEY_HASH)).toBeUndefined();
  });

  it("still resolves the tenant when the expiry is in the future", () => {
    setTenantApiKeyExpiry(TENANT_ID, new Date(Date.now() + 60_000));
    expect(getTenantByApiKeyHash(KEY_HASH)?.tenantId).toBe(TENANT_ID);
  });

  it("returns undefined for a hash that has never been registered", () => {
    expect(getTenantByApiKeyHash("never-registered-hash")).toBeUndefined();
  });
});
