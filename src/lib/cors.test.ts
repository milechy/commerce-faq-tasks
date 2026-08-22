import type { NextFunction, Request, Response } from "express";
import { createCorsMiddleware } from "./cors";

function mockReq(overrides: Record<string, unknown> = {}): Request {
  return {
    method: "GET",
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes() {
  const res: Partial<Response> & { headers: Record<string, string> } = {
    headers: {},
  };
  res.setHeader = jest.fn((name: string, value: string) => {
    res.headers[name] = value;
    return res as Response;
  }) as unknown as Response["setHeader"];
  res.status = jest.fn().mockReturnValue(res);
  res.end = jest.fn().mockReturnValue(res);
  return res as Response & { headers: Record<string, string> };
}

const nextFn: NextFunction = jest.fn();

describe("corsMiddleware", () => {
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    savedNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env.NODE_ENV = savedNodeEnv;
  });

  it("reflects origin when in the global allowlist", () => {
    const mw = createCorsMiddleware({ defaultAllowedOrigins: ["https://admin.r2c.biz"] });
    const req = mockReq({ headers: { origin: "https://admin.r2c.biz" } });
    const res = mockRes();
    mw(req, res, nextFn);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://admin.r2c.biz");
  });

  it("does not reflect origin when not in the global allowlist and no tenant check provided", () => {
    const mw = createCorsMiddleware({ defaultAllowedOrigins: ["https://admin.r2c.biz"] });
    const req = mockReq({ headers: { origin: "https://shop.example.com" } });
    const res = mockRes();
    mw(req, res, nextFn);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("reflects origin when isKnownTenantOrigin matches, even outside the global allowlist", () => {
    const mw = createCorsMiddleware({
      defaultAllowedOrigins: ["https://admin.r2c.biz"],
      isKnownTenantOrigin: (origin) => origin === "https://shop.example.com",
    });
    const req = mockReq({ headers: { origin: "https://shop.example.com" } });
    const res = mockRes();
    mw(req, res, nextFn);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://shop.example.com");
  });

  it("does not reflect origin when isKnownTenantOrigin returns false", () => {
    const mw = createCorsMiddleware({
      defaultAllowedOrigins: ["https://admin.r2c.biz"],
      isKnownTenantOrigin: () => false,
    });
    const req = mockReq({ headers: { origin: "https://unregistered.example" } });
    const res = mockRes();
    mw(req, res, nextFn);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("reflects any origin when the global allowlist is empty (dev wildcard mode, development/test only)", () => {
    process.env.NODE_ENV = "test";
    const mw = createCorsMiddleware({ defaultAllowedOrigins: [] });
    const req = mockReq({ headers: { origin: "https://anything.example" } });
    const res = mockRes();
    mw(req, res, nextFn);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://anything.example");
  });

  it("does NOT reflect any origin when the global allowlist is empty in production (fail-safe; config drift must not open CORS to everyone)", () => {
    process.env.NODE_ENV = "production";
    const mw = createCorsMiddleware({ defaultAllowedOrigins: [] });
    const req = mockReq({ headers: { origin: "https://anything.example" } });
    const res = mockRes();
    mw(req, res, nextFn);
    expect(res.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("in production with empty allowlist, still reflects an origin known to a tenant", () => {
    process.env.NODE_ENV = "production";
    const mw = createCorsMiddleware({
      defaultAllowedOrigins: [],
      isKnownTenantOrigin: (origin) => origin === "https://tenant.example.com",
    });
    const req = mockReq({ headers: { origin: "https://tenant.example.com" } });
    const res = mockRes();
    mw(req, res, nextFn);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://tenant.example.com");
  });

  it("warns at middleware creation when ALLOWED_ORIGINS is empty outside dev wildcard mode", () => {
    process.env.NODE_ENV = "production";
    const warn = jest.fn();
    createCorsMiddleware({ defaultAllowedOrigins: [], logger: { warn } as any });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("ALLOWED_ORIGINS");
  });

  it("does not warn when ALLOWED_ORIGINS is empty but dev wildcard mode is active", () => {
    process.env.NODE_ENV = "development";
    const warn = jest.fn();
    createCorsMiddleware({ defaultAllowedOrigins: [], logger: { warn } as any });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn when ALLOWED_ORIGINS is configured", () => {
    process.env.NODE_ENV = "production";
    const warn = jest.fn();
    createCorsMiddleware({ defaultAllowedOrigins: ["https://admin.r2c.biz"], logger: { warn } as any });
    expect(warn).not.toHaveBeenCalled();
  });

  it("ends the response with 204 for OPTIONS without calling next()", () => {
    const mw = createCorsMiddleware({ defaultAllowedOrigins: [] });
    const req = mockReq({ method: "OPTIONS", headers: { origin: "https://anything.example" } });
    const res = mockRes();
    mw(req, res, nextFn);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(nextFn).not.toHaveBeenCalled();
  });

  it("calls next() for non-OPTIONS requests", () => {
    const mw = createCorsMiddleware({ defaultAllowedOrigins: [] });
    const req = mockReq({ method: "POST", headers: { origin: "https://anything.example" } });
    const res = mockRes();
    mw(req, res, nextFn);
    expect(nextFn).toHaveBeenCalled();
  });

  // E2E(playwright.config.ts の extraHTTPHeaders)が x-r2c-traffic-source を全リクエストに
  // 付けるが、この許可リストに無いとプリフライトで admin-ui の全 fetch が拒否される
  // (CLAUDE.md 絶対にやってはいけないこと 22)。
  it("includes X-R2C-Traffic-Source in Access-Control-Allow-Headers", () => {
    const mw = createCorsMiddleware({ defaultAllowedOrigins: [] });
    const req = mockReq({ headers: { origin: "https://anything.example" } });
    const res = mockRes();
    mw(req, res, nextFn);
    expect(res.headers["Access-Control-Allow-Headers"]).toContain("X-R2C-Traffic-Source");
  });

  it("still includes the pre-existing allowed headers", () => {
    const mw = createCorsMiddleware({ defaultAllowedOrigins: [] });
    const req = mockReq({ headers: { origin: "https://anything.example" } });
    const res = mockRes();
    mw(req, res, nextFn);
    const allowHeaders = res.headers["Access-Control-Allow-Headers"];
    for (const h of ["Content-Type", "Authorization", "X-API-Key", "X-Tenant-ID", "X-Request-ID"]) {
      expect(allowHeaders).toContain(h);
    }
  });
});
