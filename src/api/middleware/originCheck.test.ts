// src/api/middleware/originCheck.test.ts

import type { NextFunction, Request, Response } from "express";
import { createOriginCheckMiddleware, isOriginAllowed } from "./originCheck";

function mockDb(allowedOrigins: string[]) {
  return {
    query: jest.fn().mockResolvedValue({ rows: [{ allowed_origins: allowedOrigins }] }),
  };
}

function mockReq(overrides: Record<string, unknown> = {}): Request {
  return {
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

describe("isOriginAllowed", () => {
  it("matches exact origin", () => {
    expect(isOriginAllowed("https://example.com", ["https://example.com"])).toBe(true);
  });

  it("matches wildcard", () => {
    expect(isOriginAllowed("https://sub.example.com", ["https://*.example.com"])).toBe(true);
  });

  it("rejects non-matching origin", () => {
    expect(isOriginAllowed("https://evil.com", ["https://example.com"])).toBe(false);
  });
});

describe("createOriginCheckMiddleware", () => {
  const next: NextFunction = jest.fn();

  beforeEach(() => jest.clearAllMocks());

  it("skips origin check for chat-test tokens", async () => {
    const db = mockDb(["https://example.com"]);
    const middleware = createOriginCheckMiddleware(db);
    const req = mockReq({
      tenantId: "carnation",
      isChatTestToken: true,
      headers: { origin: "https://admin.r2c.biz" },
    });
    const res = mockRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    // DB should NOT be queried when isChatTestToken is set
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rejects origin not in allowlist for normal requests", async () => {
    const db = mockDb(["https://example.com"]);
    const middleware = createOriginCheckMiddleware(db);
    const req = mockReq({
      tenantId: "carnation",
      headers: { origin: "https://evil.com" },
    });
    const res = mockRes();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("allows request when origin matches allowlist", async () => {
    const db = mockDb(["https://example.com"]);
    const middleware = createOriginCheckMiddleware(db);
    const req = mockReq({
      tenantId: "tenant-a",
      headers: { origin: "https://example.com" },
    });
    const res = mockRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("passes through when no db is provided", async () => {
    const middleware = createOriginCheckMiddleware(null);
    const req = mockReq({ tenantId: "tenant-a", headers: { origin: "https://evil.com" } });
    const res = mockRes();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});
