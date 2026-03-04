import type { NextFunction, Response } from "express";
import { createSecurityPolicyMiddleware } from "./security-policy";
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
});
