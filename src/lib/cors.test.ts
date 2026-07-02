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
  beforeEach(() => jest.clearAllMocks());

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

  it("reflects any origin when the global allowlist is empty (dev wildcard mode)", () => {
    const mw = createCorsMiddleware({ defaultAllowedOrigins: [] });
    const req = mockReq({ headers: { origin: "https://anything.example" } });
    const res = mockRes();
    mw(req, res, nextFn);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://anything.example");
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
});
