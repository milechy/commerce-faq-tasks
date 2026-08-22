import type { NextFunction, Response } from "express";
import { createSecurityPolicyMiddleware } from "./security-policy";
import { isOriginAllowed } from "../api/middleware/originCheck";
import type { AuthedRequest } from "../agent/http/authMiddleware";
import type { TenantConfig } from "../types/contracts";

function mockReq(overrides: Record<string, unknown> = {}): AuthedRequest {
  return {
    path: "/api/chat",
    headers: {},
    tenantId: "t1",
    tenantConfig: undefined,
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

const baseTenant: TenantConfig = {
  tenantId: "t1",
  name: "Test",
  plan: "growth",
  features: { avatar: false, voice: false, rag: true },
  security: {
    apiKeyHash: "abc",
    hashAlgorithm: "sha256",
    allowedOrigins: ["https://app.example.com"],
    rateLimit: 100,
    rateLimitWindowMs: 60_000,
  },
  enabled: true,
};

describe("securityPolicyMiddleware", () => {
  beforeEach(() => jest.clearAllMocks());

  const mw = createSecurityPolicyMiddleware();

  it("allows request with matching origin", () => {
    const req = mockReq({
      tenantConfig: baseTenant,
      headers: { origin: "https://app.example.com" },
    });
    mw(req as any, mockRes(), nextFn);
    expect(nextFn).toHaveBeenCalled();
  });

  it("rejects request with non-matching origin", () => {
    const req = mockReq({
      tenantConfig: baseTenant,
      headers: { origin: "https://evil.com" },
    });
    const res = mockRes();
    mw(req as any, res, nextFn);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("passes through when allowedOrigins is empty", () => {
    const config = {
      ...baseTenant,
      security: { ...baseTenant.security, allowedOrigins: [] },
    };
    const req = mockReq({
      tenantConfig: config,
      headers: { origin: "https://anything.com" },
    });
    mw(req as any, mockRes(), nextFn);
    expect(nextFn).toHaveBeenCalled();
  });

  it("passes through when no tenantConfig", () => {
    const req = mockReq({ tenantConfig: undefined });
    mw(req as any, mockRes(), nextFn);
    expect(nextFn).toHaveBeenCalled();
  });

  it("skips enforcement for /ce/status", () => {
    const req = mockReq({
      path: "/ce/status",
      tenantConfig: baseTenant,
      headers: { origin: "https://evil.com" },
    });
    mw(req as any, mockRes(), nextFn);
    expect(nextFn).toHaveBeenCalled();
  });

  // 以前は完全一致(allowed.includes)だったため、UIが案内する
  // `https://*.example.com` は securityPolicy(apiStackで先に走る)で必ず403になり、
  // 後段の originCheck.ts が持つワイルドカード対応は到達しなかった。
  it("honours a subdomain wildcard (previously always 403 here)", () => {
    const req = mockReq({
      tenantConfig: {
        ...baseTenant,
        security: { ...baseTenant.security, allowedOrigins: ["https://*.example.com"] },
      },
      headers: { origin: "https://shop.example.com" },
    });
    mw(req as any, mockRes(), nextFn);
    expect(nextFn).toHaveBeenCalled();
  });

  it("still rejects an origin outside the wildcard", () => {
    const req = mockReq({
      tenantConfig: {
        ...baseTenant,
        security: { ...baseTenant.security, allowedOrigins: ["https://*.example.com"] },
      },
      headers: { origin: "https://evil.com" },
    });
    const res = mockRes();
    mw(req as any, res, nextFn);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("does not honour a bare https:// wildcard as match-all", () => {
    const req = mockReq({
      tenantConfig: {
        ...baseTenant,
        security: { ...baseTenant.security, allowedOrigins: ["https://*"] },
      },
      headers: { origin: "https://evil.com" },
    });
    const res = mockRes();
    mw(req as any, res, nextFn);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(nextFn).not.toHaveBeenCalled();
  });
});

// securityPolicy(インメモリ) と originCheck(DB) が同じ判定に収束したことの証明。
// 片方だけワイルドカードを解釈する状態に戻ると、この表のどこかが必ず食い違う。
describe("securityPolicy / originCheck 判定の一致", () => {
  const mw = createSecurityPolicyMiddleware();

  const cases: Array<[origin: string, allowed: string[], expected: boolean]> = [
    ["https://app.example.com", ["https://app.example.com"], true],
    ["https://shop.example.com", ["https://*.example.com"], true],
    ["https://a.b.example.com", ["https://*.example.com"], true],
    ["https://example.com", ["https://*.example.com"], false],
    ["https://evil.com", ["https://*.example.com"], false],
    ["https://x.example.com.evil.com", ["https://*.example.com"], false],
    ["https://evil.com", ["https://*"], false],
    ["https://notevil.com", ["https://*evil.com"], false],
  ];

  it.each(cases)(
    "origin=%s allowed=%j → allowed=%s (両実装で一致)",
    (origin, allowed, expected) => {
      // originCheck 側の純関数
      expect(isOriginAllowed(origin, allowed)).toBe(expected);

      // securityPolicy 側(ミドルウェア経由)
      const next = jest.fn();
      const res = mockRes();
      const req = mockReq({
        tenantConfig: {
          ...baseTenant,
          security: { ...baseTenant.security, allowedOrigins: allowed },
        },
        headers: { origin },
      });
      mw(req as any, res, next);
      expect(next.mock.calls.length > 0).toBe(expected);
    }
  );
});
