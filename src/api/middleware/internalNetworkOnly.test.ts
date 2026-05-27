// src/api/middleware/internalNetworkOnly.test.ts
//
// X-Internal-Request spoofability 修正 (GID 1215119240093940) のテスト。
// allow/deny 両面 + supertest による正当 localhost 経路の通過を保証する。

import type { NextFunction, Request, Response } from "express";
import express from "express";
import request from "supertest";
import { internalNetworkOnly, isLoopbackAddress } from "./internalNetworkOnly";

jest.mock("../../lib/logger", () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

function makeReq(remoteAddress: string | undefined, headers: Record<string, string> = {}): Request {
  return {
    socket: { remoteAddress } as unknown as Request["socket"],
    headers,
    path: "/api/internal/test",
    method: "GET",
  } as unknown as Request;
}

function makeRes() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

describe("isLoopbackAddress", () => {
  it("allows 127.0.0.1", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
  });
  it("allows ::1", () => {
    expect(isLoopbackAddress("::1")).toBe(true);
  });
  it("allows IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", () => {
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });
  // Codex Round 2: 127.0.0.0/8 is loopback per RFC 5735, not just 127.0.0.1
  it("allows other addresses in 127.0.0.0/8 (e.g. 127.0.0.2)", () => {
    expect(isLoopbackAddress("127.0.0.2")).toBe(true);
  });
  it("allows 127.1.2.3 (rest of 127/8)", () => {
    expect(isLoopbackAddress("127.1.2.3")).toBe(true);
  });
  it("allows ::ffff:127.0.0.2 (mapped, non-canonical loopback)", () => {
    expect(isLoopbackAddress("::ffff:127.0.0.2")).toBe(true);
  });
  it("allows mixed-case IPv4-mapped prefix (::FFFF:127.0.0.1)", () => {
    expect(isLoopbackAddress("::FFFF:127.0.0.1")).toBe(true);
  });
  it("trims surrounding whitespace before evaluation", () => {
    expect(isLoopbackAddress("  127.0.0.1  ")).toBe(true);
  });
  it("denies undefined (fail-closed)", () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
  it("denies null (fail-closed)", () => {
    expect(isLoopbackAddress(null)).toBe(false);
  });
  it("denies empty string (fail-closed)", () => {
    expect(isLoopbackAddress("")).toBe(false);
  });
  it("denies an external IPv4", () => {
    expect(isLoopbackAddress("8.8.8.8")).toBe(false);
  });
  it("denies an internal RFC1918 IPv4 (10.x)", () => {
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
  });
  it("denies a Cloudflare edge IP (representative sample)", () => {
    expect(isLoopbackAddress("172.69.5.10")).toBe(false);
  });
  it("denies a public IPv6", () => {
    expect(isLoopbackAddress("2606:4700:4700::1111")).toBe(false);
  });
  it("denies a deceptive string that contains 127.0.0.1 as substring", () => {
    expect(isLoopbackAddress("127.0.0.1.evil.example.com")).toBe(false);
  });
  it("denies 128.0.0.1 (off-by-one above 127/8)", () => {
    expect(isLoopbackAddress("128.0.0.1")).toBe(false);
  });
  it("denies ::ffff:8.8.8.8 (mapped non-loopback)", () => {
    expect(isLoopbackAddress("::ffff:8.8.8.8")).toBe(false);
  });
  it("denies malformed IPv4 (octets > 255)", () => {
    expect(isLoopbackAddress("127.0.0.999")).toBe(false);
  });
  it("denies leading-zero / non-decimal forms (avoids ambiguous parsers)", () => {
    // Defensively: '127.000.000.001' MIGHT be normalized to 127.0.0.1 in some
    // libs; we only accept literal 1-3 digit decimal octets to stay predictable.
    expect(isLoopbackAddress("0177.0.0.1")).toBe(false);
  });
  it("denies non-string inputs", () => {
    expect(isLoopbackAddress(123 as unknown as string)).toBe(false);
  });
});

describe("internalNetworkOnly middleware (unit)", () => {
  const next = jest.fn() as NextFunction;
  beforeEach(() => jest.clearAllMocks());

  it("allows 127.0.0.1 socket peer", () => {
    const req = makeReq("127.0.0.1");
    const res = makeRes();
    internalNetworkOnly(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows ::1 socket peer", () => {
    const req = makeReq("::1");
    const res = makeRes();
    internalNetworkOnly(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("denies external IP (8.8.8.8) with 403", () => {
    const req = makeReq("8.8.8.8");
    const res = makeRes();
    internalNetworkOnly(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "forbidden" });
  });

  it("ignores spoofed X-Forwarded-For: 127.0.0.1 (header cannot override socket)", () => {
    const req = makeReq("8.8.8.8", {
      "x-forwarded-for": "127.0.0.1",
      "x-real-ip": "127.0.0.1",
    });
    const res = makeRes();
    internalNetworkOnly(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("fail-closes when socket.remoteAddress is undefined", () => {
    const req = makeReq(undefined);
    const res = makeRes();
    internalNetworkOnly(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("internalNetworkOnly middleware (supertest integration)", () => {
  // supertest が同一プロセス内 ephemeral サーバを 127.0.0.1 で起動するので、
  // socket.remoteAddress は 127.0.0.1 (もしくは ::ffff:127.0.0.1) になる。
  // これは avatar-agent の RAJIUCE_API_URL=http://localhost:3100 経由と同じ条件。

  it("allows supertest call (= avatar-agent localhost 経路の代理検証)", async () => {
    const app = express();
    app.get("/internal/test", internalNetworkOnly, (_req, res) => {
      res.json({ ok: true });
    });
    const res = await request(app).get("/internal/test");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 403 if we monkey-patch the socket remoteAddress to an external IP", async () => {
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, "remoteAddress", {
        value: "203.0.113.42",
        configurable: true,
      });
      next();
    });
    app.get("/internal/test", internalNetworkOnly, (_req, res) => {
      res.json({ ok: true });
    });
    const res = await request(app).get("/internal/test");
    expect(res.status).toBe(403);
  });
});
