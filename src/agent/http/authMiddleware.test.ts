import crypto from "node:crypto";
import type { NextFunction, Response } from "express";
import { initAuthMiddleware, type AuthedRequest } from "./authMiddleware";
import type { TenantConfig } from "../../types/contracts";

function mockReq(overrides: Record<string, unknown> = {}): AuthedRequest {
  const headers: Record<string, string> = {};
  return {
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    headers,
    body: {},
    tenantId: undefined as unknown as string,
    ...overrides,
  } as unknown as AuthedRequest;
}

function mockRes() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

const nextFn: NextFunction = jest.fn();

const TEST_API_KEY = "test-secret-key-12345";
const TEST_API_KEY_HASH = crypto
  .createHash("sha256")
  .update(TEST_API_KEY)
  .digest("hex");

const tenantConfig: TenantConfig = {
  tenantId: "tenant-abc",
  name: "Test Tenant",
  plan: "growth",
  features: { avatar: false, voice: false, rag: true },
  security: {
    apiKeyHash: TEST_API_KEY_HASH,
    hashAlgorithm: "sha256",
    allowedOrigins: ["https://example.com"],
    rateLimit: 200,
    rateLimitWindowMs: 60_000,
  },
  enabled: true,
};

describe("initAuthMiddleware", () => {
  beforeEach(() => jest.clearAllMocks());

  const middleware = initAuthMiddleware({
    resolveByApiKeyHash: (hash) =>
      hash === TEST_API_KEY_HASH ? tenantConfig : undefined,
    legacyApiKey: undefined,
    legacyBasicUser: undefined,
    legacyBasicPass: undefined,
  });

  it("rejects request with no credentials (401)", () => {
    const req = mockReq();
    const res = mockRes();
    middleware(req, res, nextFn);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("authenticates via x-api-key hash lookup", () => {
    const headers: Record<string, string> = {
      "x-api-key": TEST_API_KEY,
    };
    const req = mockReq({
      headers,
      header: (name: string) => headers[name.toLowerCase()],
    });
    const res = mockRes();
    middleware(req, res, nextFn);

    expect(nextFn).toHaveBeenCalled();
    expect(req.tenantId).toBe("tenant-abc");
    expect(req.tenantConfig).toBe(tenantConfig);
  });

  it("rejects invalid api key", () => {
    const headers: Record<string, string> = {
      "x-api-key": "wrong-key",
    };
    const req = mockReq({
      headers,
      header: (name: string) => headers[name.toLowerCase()],
    });
    const res = mockRes();
    middleware(req, res, nextFn);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("does NOT read tenantId from body (CLAUDE.md compliance)", () => {
    const headers: Record<string, string> = {
      "x-api-key": TEST_API_KEY,
    };
    const req = mockReq({
      headers,
      header: (name: string) => headers[name.toLowerCase()],
      body: { tenantId: "should-be-ignored" },
    });
    const res = mockRes();
    middleware(req, res, nextFn);

    expect(nextFn).toHaveBeenCalled();
    expect(req.tenantId).toBe("tenant-abc");
    expect(req.tenantId).not.toBe("should-be-ignored");
  });

  it("rejects disabled tenant", () => {
    const disabledConfig = { ...tenantConfig, enabled: false };
    const mw = initAuthMiddleware({
      resolveByApiKeyHash: (hash) =>
        hash === TEST_API_KEY_HASH ? disabledConfig : undefined,
    });
    const headers: Record<string, string> = {
      "x-api-key": TEST_API_KEY,
    };
    const req = mockReq({
      headers,
      header: (name: string) => headers[name.toLowerCase()],
    });
    const res = mockRes();
    mw(req, res, nextFn);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(nextFn).not.toHaveBeenCalled();
  });
});

describe("initAuthMiddleware — legacy API_KEY fallback", () => {
  beforeEach(() => jest.clearAllMocks());

  const middleware = initAuthMiddleware({
    legacyApiKey: "legacy-key",
  });

  it("allows legacy plain-text api key and uses API_KEY_TENANT_ID env (not x-tenant-id header)", () => {
    // P0: tenantId は x-tenant-id ヘッダーからではなく API_KEY_TENANT_ID env var から取得する
    const headers: Record<string, string> = {
      "x-api-key": "legacy-key",
      "x-tenant-id": "should-be-ignored", // このヘッダーは無視される
    };
    const req = mockReq({
      headers,
      header: (name: string) => headers[name.toLowerCase()],
    });
    const res = mockRes();
    middleware(req, res, nextFn);

    expect(nextFn).toHaveBeenCalled();
    // API_KEY_TENANT_ID が未設定なので "default" が使われる
    expect(req.tenantId).toBe("default");
  });
});
