import crypto from "node:crypto";
import type { NextFunction, Response } from "express";
import { initAuthMiddleware, type AuthedRequest } from "./authMiddleware";
import type { TenantConfig } from "../../types/contracts";
import { verifySupabaseJwt } from "../../auth/verifySupabaseJwt";

jest.mock("../../auth/verifySupabaseJwt", () => ({
  verifySupabaseJwt: jest.fn(),
}));
const mockVerifySupabaseJwt = verifySupabaseJwt as jest.Mock;

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

describe("initAuthMiddleware — Bearer JWT path", () => {
  beforeEach(() => jest.clearAllMocks());

  const middleware = initAuthMiddleware({
    resolveByApiKeyHash: () => undefined,
    legacyApiKey: undefined,
    legacyBasicUser: undefined,
    legacyBasicPass: undefined,
  });

  function bearerReq(token: string): AuthedRequest {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    return mockReq({ headers, header: (name: string) => headers[name.toLowerCase()] });
  }

  it("rejects a valid JWT that has no tenant_id (no demo fallback)", () => {
    mockVerifySupabaseJwt.mockReturnValue({ sub: "user-1", app_metadata: {} });
    const req = bearerReq("valid-but-no-tenant");
    const res = mockRes();
    middleware(req, res, nextFn);

    expect(nextFn).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(req.tenantId).toBeUndefined();
  });

  it("accepts a valid JWT with app_metadata.tenant_id", () => {
    mockVerifySupabaseJwt.mockReturnValue({
      sub: "user-1",
      app_metadata: { tenant_id: "tenant-abc", role: "client_admin" },
    });
    const req = bearerReq("valid-with-tenant");
    const res = mockRes();
    middleware(req, res, nextFn);

    expect(nextFn).toHaveBeenCalled();
    expect(req.tenantId).toBe("tenant-abc");
  });

  it("rejects an invalid/unverifiable JWT", () => {
    mockVerifySupabaseJwt.mockReturnValue(null);
    const req = bearerReq("garbage");
    const res = mockRes();
    middleware(req, res, nextFn);

    expect(nextFn).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects an explicit empty-string tenant_id (falsy-value trap, not just undefined)", () => {
    mockVerifySupabaseJwt.mockReturnValue({
      sub: "user-1",
      app_metadata: { tenant_id: "", role: "client_admin" },
    });
    const req = bearerReq("empty-tenant");
    const res = mockRes();
    middleware(req, res, nextFn);

    expect(nextFn).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("does NOT fall back to top-level tenant_id when app_metadata.tenant_id is an explicit empty string (?? vs || trap)", () => {
    // app_metadata.tenant_id === "" is not null/undefined, so `??` must NOT skip past it
    // to the top-level tenant_id, even though the top-level value looks usable.
    mockVerifySupabaseJwt.mockReturnValue({
      sub: "user-1",
      tenant_id: "top-level-tenant",
      app_metadata: { tenant_id: "", role: "client_admin" },
    });
    const req = bearerReq("empty-app-metadata-tenant-with-toplevel-fallback");
    const res = mockRes();
    middleware(req, res, nextFn);

    expect(nextFn).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("prefers app_metadata.tenant_id over a differing top-level tenant_id when both are present", () => {
    mockVerifySupabaseJwt.mockReturnValue({
      sub: "user-1",
      tenant_id: "top-level-tenant",
      app_metadata: { tenant_id: "app-metadata-tenant", role: "client_admin" },
    });
    const req = bearerReq("both-present-differing");
    const res = mockRes();
    middleware(req, res, nextFn);

    expect(nextFn).toHaveBeenCalled();
    expect(req.tenantId).toBe("app-metadata-tenant");
  });

  it("falls back to top-level tenant_id only when app_metadata.tenant_id is genuinely absent (undefined)", () => {
    mockVerifySupabaseJwt.mockReturnValue({
      sub: "user-1",
      tenant_id: "top-level-tenant",
      app_metadata: { role: "client_admin" },
    });
    const req = bearerReq("toplevel-fallback-only-when-undefined");
    const res = mockRes();
    middleware(req, res, nextFn);

    expect(nextFn).toHaveBeenCalled();
    expect(req.tenantId).toBe("top-level-tenant");
  });

  it("rejects when app_metadata itself is null (optional chaining must not throw, falls through to 401)", () => {
    mockVerifySupabaseJwt.mockReturnValue({
      sub: "user-1",
      app_metadata: null,
    });
    const req = bearerReq("null-app-metadata");
    const res = mockRes();
    expect(() => middleware(req, res, nextFn)).not.toThrow();

    expect(nextFn).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects a Bearer header with an empty token after the prefix", () => {
    const req = bearerReq("");
    // bearerReq builds "Bearer " + token, so an empty token yields header "Bearer " (trailing space, no token)
    const res = mockRes();
    mockVerifySupabaseJwt.mockReturnValue(null);
    middleware(req, res, nextFn);

    expect(nextFn).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockVerifySupabaseJwt).toHaveBeenCalledWith("");
  });

  it("does not treat a lowercase 'bearer ' prefix as the Bearer path (case-sensitive prefix check)", () => {
    // authHeader.startsWith("Bearer ") is case-sensitive; "bearer xxx" must NOT match Path 1,
    // and since it also doesn't match x-api-key/Basic, it must fall through to the generic 401.
    const headers: Record<string, string> = { authorization: "bearer some-token" };
    const req = mockReq({ headers, header: (name: string) => headers[name.toLowerCase()] });
    const res = mockRes();
    middleware(req, res, nextFn);

    expect(mockVerifySupabaseJwt).not.toHaveBeenCalled();
    expect(nextFn).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "unauthorized" })
    );
  });

  it("takes the Bearer path even when x-api-key is also present (Bearer has priority)", () => {
    const headers: Record<string, string> = {
      authorization: "Bearer valid-with-tenant",
      "x-api-key": TEST_API_KEY,
    };
    const req = mockReq({ headers, header: (name: string) => headers[name.toLowerCase()] });
    mockVerifySupabaseJwt.mockReturnValue({
      sub: "user-1",
      app_metadata: { tenant_id: "tenant-from-jwt", role: "client_admin" },
    });
    const res = mockRes();
    middleware(req, res, nextFn);

    expect(nextFn).toHaveBeenCalled();
    // Must resolve via the JWT path, not silently fall through to api-key resolution.
    expect(req.tenantId).toBe("tenant-from-jwt");
    expect(req.tenantConfig).toBeUndefined();
  });
});
