// src/api/middleware/originCheck.test.ts

import type { NextFunction, Request, Response } from "express";
import { createOriginCheckMiddleware, isOriginAllowed, isValidOriginPattern } from "./originCheck";

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

  // --- ワイルドカードの厳格化 ---------------------------------------------
  // `https://*` は tenant-context.ts の isOriginKnownToAnyTenant 経由で CORS に効くため、
  // 1テナントが登録するだけで全テナントの Access-Control-Allow-Origin が任意オリジンを
  // 反射するようになる。照合側でも無効化して二重に塞ぐ。
  it("does not treat a bare https://* as a match-all pattern", () => {
    expect(isOriginAllowed("https://evil.com", ["https://*"])).toBe(false);
    expect(isOriginAllowed("https://anything.at.all", ["https://*"])).toBe(false);
  });

  it("does not expand a mid-label wildcard (https://*evil.com must not match notevil.com)", () => {
    expect(isOriginAllowed("https://notevil.com", ["https://*evil.com"])).toBe(false);
  });

  it("rejects patterns with more than one wildcard", () => {
    expect(isOriginAllowed("https://a.b.com", ["https://*.a.*.com"])).toBe(false);
  });

  it("matches nested subdomains under a subdomain wildcard", () => {
    expect(isOriginAllowed("https://a.b.example.com", ["https://*.example.com"])).toBe(true);
  });

  it("does not match the apex domain under a subdomain wildcard", () => {
    expect(isOriginAllowed("https://example.com", ["https://*.example.com"])).toBe(false);
  });

  it("does not match an empty label under a subdomain wildcard", () => {
    expect(isOriginAllowed("https://.example.com", ["https://*.example.com"])).toBe(false);
  });

  // 既存のエスケープ順序(`.`→`\.` を先、`*` 展開を後)が壊れていないことの回帰防止。
  // 壊れると https://x.example.com.evil.com が https://*.example.com にマッチしてしまう。
  it("does not match a suffix-smuggling origin", () => {
    expect(
      isOriginAllowed("https://x.example.com.evil.com", ["https://*.example.com"])
    ).toBe(false);
  });

  // 2026-08-25: `https://*.com` のような単一ラベルのジェネリックTLD直下ワイルドカードが
  // 「安全な形」として通過し、任意の .com オリジンにマッチしてしまっていた実装の穴。
  it("does not match an arbitrary .com origin under a single-label wildcard", () => {
    expect(isOriginAllowed("https://evil.com", ["https://*.com"])).toBe(false);
    expect(isOriginAllowed("https://anything.net", ["https://*.net"])).toBe(false);
    expect(isOriginAllowed("https://sub.jp", ["https://*.jp"])).toBe(false);
  });

  // 2ラベルでも、誰でも取得できるパブリックサフィックス(co.jp等)を直下に置くと
  // 任意の企業ドメインにマッチしてしまう。KNOWN_PUBLIC_SUFFIXES で個別に塞ぐ。
  it("does not match an arbitrary origin under a known public-suffix wildcard", () => {
    expect(isOriginAllowed("https://rakuten.co.jp", ["https://*.co.jp"])).toBe(false);
    expect(isOriginAllowed("https://example.ne.jp", ["https://*.ne.jp"])).toBe(false);
  });

  // 真の2ラベルドメイン(パブリックサフィックスではない)は引き続き許可される。
  it("still matches a genuine two-label domain wildcard", () => {
    expect(isOriginAllowed("https://sub.example.com", ["https://*.example.com"])).toBe(true);
    expect(isOriginAllowed("https://sub.shop.co.jp", ["https://*.shop.co.jp"])).toBe(true);
  });
});

describe("isValidOriginPattern", () => {
  it.each([
    "https://example.com",
    "https://shop.example.com",
    "https://*.example.com",
  ])("accepts %s", (value) => {
    expect(isValidOriginPattern(value)).toBe(true);
  });

  it.each([
    "https://*",
    "https://*evil.com",
    "https://*.a.*.com",
    "https://*.example.com/path",
    "http://example.com",
    "example.com",
  ])("rejects %s", (value) => {
    expect(isValidOriginPattern(value)).toBe(false);
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
