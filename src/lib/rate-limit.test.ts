import { createRateLimitMiddleware } from "./rate-limit";

type MockReq = {
  header: (name: string) => string | undefined;
  ip?: string;
  requestId?: string;
  tenantId?: string;
};

function mockReq(opts: {
  xRealIp?: string;
  ip?: string;
  tenantId?: string;
}): MockReq {
  return {
    header: (name: string) =>
      name.toLowerCase() === "x-real-ip" ? opts.xRealIp : undefined,
    ip: opts.ip,
    requestId: "req-1",
    tenantId: opts.tenantId,
  };
}

function mockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown;
  return {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    status: (code: number) => {
      statusCode = code;
      return {
        json: (b: unknown) => {
          body = b;
        },
      };
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    headers,
  };
}

describe("createRateLimitMiddleware", () => {
  it("stage: 'ip' — keys by X-Real-IP; different IPs get independent buckets", () => {
    const mw = createRateLimitMiddleware({ stage: "ip", getLimit: () => 1 });

    const reqA = mockReq({ xRealIp: "1.1.1.1" });
    const resA1 = mockRes();
    let calledA1 = false;
    mw(reqA as never, resA1 as never, () => {
      calledA1 = true;
    });
    expect(calledA1).toBe(true);

    // Second request from the same IP within the limit window should be blocked.
    const resA2 = mockRes();
    let calledA2 = false;
    mw(reqA as never, resA2 as never, () => {
      calledA2 = true;
    });
    expect(calledA2).toBe(false);
    expect(resA2.statusCode).toBe(429);

    // A different IP must not be affected by IP A's exhausted bucket.
    const reqB = mockReq({ xRealIp: "2.2.2.2" });
    const resB1 = mockRes();
    let calledB1 = false;
    mw(reqB as never, resB1 as never, () => {
      calledB1 = true;
    });
    expect(calledB1).toBe(true);
  });

  it("stage: 'ip' — falls back to req.ip when X-Real-IP is absent", () => {
    const mw = createRateLimitMiddleware({ stage: "ip", getLimit: () => 5 });
    const req = mockReq({ ip: "9.9.9.9" });
    const res = mockRes();
    let called = false;
    mw(req as never, res as never, () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it("stage: 'tenant' — keys by tenantId; different tenants get independent buckets", () => {
    const mw = createRateLimitMiddleware({ stage: "tenant", getLimit: () => 1 });

    const reqA = mockReq({ tenantId: "tenantA" });
    const resA1 = mockRes();
    let calledA1 = false;
    mw(reqA as never, resA1 as never, () => {
      calledA1 = true;
    });
    expect(calledA1).toBe(true);

    const resA2 = mockRes();
    let calledA2 = false;
    mw(reqA as never, resA2 as never, () => {
      calledA2 = true;
    });
    expect(calledA2).toBe(false);
    expect(resA2.statusCode).toBe(429);

    const reqB = mockReq({ tenantId: "tenantB" });
    const resB1 = mockRes();
    let calledB1 = false;
    mw(reqB as never, resB1 as never, () => {
      calledB1 = true;
    });
    expect(calledB1).toBe(true);
  });

  it("stage unset — legacy behavior identical to 'tenant' (backward compatible)", () => {
    const mw = createRateLimitMiddleware({ getLimit: () => 1 });

    const reqA = mockReq({ tenantId: "tenantLegacyA" });
    const resA1 = mockRes();
    let calledA1 = false;
    mw(reqA as never, resA1 as never, () => {
      calledA1 = true;
    });
    expect(calledA1).toBe(true);

    const resA2 = mockRes();
    let calledA2 = false;
    mw(reqA as never, resA2 as never, () => {
      calledA2 = true;
    });
    expect(calledA2).toBe(false);
    expect(resA2.statusCode).toBe(429);
    expect(resA2.body).toMatchObject({
      error: "rate_limit_exceeded",
      tenantId: "tenantLegacyA",
    });
  });

  it("exact boundary — Nth request passes, N+1th is blocked (limit=3)", () => {
    const mw = createRateLimitMiddleware({ stage: "tenant", getLimit: () => 3 });
    const req = mockReq({ tenantId: "tenant-boundary" });

    const results: number[] = [];
    for (let i = 0; i < 4; i++) {
      const res = mockRes();
      let called = false;
      mw(req as never, res as never, () => {
        called = true;
      });
      results.push(called ? 200 : res.statusCode);
    }
    // 1st-3rd pass (200 = "called next()"), 4th is blocked (429)
    expect(results).toEqual([200, 200, 200, 429]);
  });

  it("window reset boundary — request just before windowMs is blocked, just after is allowed", () => {
    jest.useFakeTimers();
    try {
      const mw = createRateLimitMiddleware({
        stage: "tenant",
        getLimit: () => 1,
      });
      const req = mockReq({ tenantId: "tenant-window" });

      const res1 = mockRes();
      mw(req as never, res1 as never, () => {});
      expect(res1.statusCode).toBe(200);

      // Advance to 1ms before the window resets — still blocked.
      // (DEFAULT_WINDOW_MS in rate-limit.ts is 60_000ms; not exported, so
      // duplicated here deliberately — a change to that constant should
      // make this assertion fail loudly rather than silently drift.)
      const DEFAULT_WINDOW_MS = 60_000;
      jest.advanceTimersByTime(DEFAULT_WINDOW_MS - 1);
      const res2 = mockRes();
      let called2 = false;
      mw(req as never, res2 as never, () => {
        called2 = true;
      });
      expect(called2).toBe(false);
      expect(res2.statusCode).toBe(429);

      // Advance past the window — now allowed again.
      jest.advanceTimersByTime(2);
      const res3 = mockRes();
      let called3 = false;
      mw(req as never, res3 as never, () => {
        called3 = true;
      });
      expect(called3).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("stage: 'ip' — different req.ip fallback values get independent buckets (not merged into one)", () => {
    const mw = createRateLimitMiddleware({ stage: "ip", getLimit: () => 1 });

    const reqA = mockReq({ ip: "10.0.0.1" }); // no x-real-ip → falls back to req.ip
    const resA1 = mockRes();
    mw(reqA as never, resA1 as never, () => {});
    expect(resA1.statusCode).toBe(200);
    const resA2 = mockRes();
    let calledA2 = false;
    mw(reqA as never, resA2 as never, () => {
      calledA2 = true;
    });
    expect(calledA2).toBe(false); // A's own bucket now exhausted

    const reqB = mockReq({ ip: "10.0.0.2" }); // different req.ip
    const resB1 = mockRes();
    let calledB1 = false;
    mw(reqB as never, resB1 as never, () => {
      calledB1 = true;
    });
    expect(calledB1).toBe(true); // must not be blocked by A's bucket
  });

  it("stage: 'ip' — both X-Real-IP and req.ip absent: falls back to a shared anonymous bucket (documented risk — see below)", () => {
    const mw = createRateLimitMiddleware({ stage: "ip", getLimit: () => 1 });

    const reqA = mockReq({}); // neither xRealIp nor ip set
    const resA1 = mockRes();
    mw(reqA as never, resA1 as never, () => {});
    expect(resA1.statusCode).toBe(200);

    const reqB = mockReq({}); // also neither set — a *different* real client in production
    const resB1 = mockRes();
    let calledB1 = false;
    mw(reqB as never, resB1 as never, () => {
      calledB1 = true;
    });
    // RISK: with no X-Real-IP and no req.ip, both clients collapse onto the
    // same "unknown-ip" bucket and can rate-limit each other. In production
    // this path should be unreachable (nginx always injects X-Real-IP), but
    // any nginx misconfiguration reintroduces the single-bucket DoS this
    // stage split was built to fix. See risk report below.
    expect(calledB1).toBe(false);
  });

  it("X-Real-IP is whitespace-only — treated as absent, falls back to req.ip", () => {
    const mw = createRateLimitMiddleware({ stage: "ip", getLimit: () => 5 });
    const req = mockReq({ xRealIp: "   ", ip: "10.0.0.9" });
    const res = mockRes();
    let called = false;
    mw(req as never, res as never, () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it("[修正確認] 名前空間の対称化により、ip-stageキー文字列と同名のtenantIdでも衝突しない", () => {
    // 修正前: stage:'ip' キーは "ip:<addr>" 接頭辞付き、stage:'tenant' キーは
    // 生のtenantIdで接頭辞無し。tenantが文字通り "ip:1.2.3.4" という名前だと
    // 両stageが同一の module-level `store` を共有しているため、そのIPアドレスの
    // レートリミットバケットと衝突していた（tenantIdはtenant作成時にクライアント側で
    // 選択可能なため、tenants/routes.ts のバリデーション次第では到達しうる形だった）。
    // 修正後: stage:'tenant' にも "tenant:" 接頭辞を付与し、両stageを完全に独立させた。
    const ipMw = createRateLimitMiddleware({ stage: "ip", getLimit: () => 1 });
    const tenantMw = createRateLimitMiddleware({ stage: "tenant", getLimit: () => 1 });

    const ipReq = mockReq({ xRealIp: "5.5.5.5" });
    const ipRes = mockRes();
    ipMw(ipReq as never, ipRes as never, () => {});
    expect(ipRes.statusCode).toBe(200); // "ip:5.5.5.5" バケットを消費

    const formerlyCollidingTenantReq = mockReq({ tenantId: "ip:5.5.5.5" });
    const tenantRes = mockRes();
    let calledTenant = false;
    tenantMw(formerlyCollidingTenantReq as never, tenantRes as never, () => {
      calledTenant = true;
    });
    // 修正後は独立した名前空間 ("tenant:ip:5.5.5.5") になるため、
    // 新規テナントの初回リクエストが無関係なIPバケット枯渇の影響を受けない。
    expect(calledTenant).toBe(true);
  });

  it("getLimit receives the resolved key (IP-prefixed for stage:'ip', tenant-prefixed for stage:'tenant')", () => {
    const seenKeys: string[] = [];
    const ipMw = createRateLimitMiddleware({
      stage: "ip",
      getLimit: (k) => {
        seenKeys.push(k);
        return 5;
      },
    });
    const tenantMw = createRateLimitMiddleware({
      stage: "tenant",
      getLimit: (k) => {
        seenKeys.push(k);
        return 5;
      },
    });

    ipMw(mockReq({ xRealIp: "8.8.8.8" }) as never, mockRes() as never, () => {});
    tenantMw(mockReq({ tenantId: "tenantX" }) as never, mockRes() as never, () => {});

    expect(seenKeys).toEqual(["ip:8.8.8.8", "tenant:tenantX"]);
  });

  it("stage未指定（legacy/back-compat）は接頭辞無しの既存キー形式を維持する", () => {
    const legacyMw = createRateLimitMiddleware({ getLimit: () => 1 });
    const tenantMw = createRateLimitMiddleware({ stage: "tenant", getLimit: () => 1 });

    // legacy(stage未指定)は "tenantY" そのまま、tenant段は "tenant:tenantY" と
    // 別名前空間になるため、legacy呼び出し元とstage移行後の呼び出し元は
    // バケットを共有しない（意図的な非共有。将来的にlegacy呼び出しを
    // 全てstage指定へ移行すべきだが、それ自体は本修正の範囲外）。
    const legacyReq = mockReq({ tenantId: "tenantY" });
    const legacyRes = mockRes();
    legacyMw(legacyReq as never, legacyRes as never, () => {});
    expect(legacyRes.statusCode).toBe(200); // legacy "tenantY" バケットを消費

    const tenantReq = mockReq({ tenantId: "tenantY" });
    const tenantRes = mockRes();
    let called = false;
    tenantMw(tenantReq as never, tenantRes as never, () => {
      called = true;
    });
    expect(called).toBe(true); // "tenant:tenantY" は別バケットなので影響を受けない
  });

  it("429 response always reports authed.tenantId (or 'anonymous'), never the IP-based key — avoids leaking the rate-limit key to the client", () => {
    const mw = createRateLimitMiddleware({ stage: "ip", getLimit: () => 1 });
    const req = mockReq({ xRealIp: "7.7.7.7", tenantId: "real-tenant" });

    mw(req as never, mockRes() as never, () => {});
    const res2 = mockRes();
    mw(req as never, res2 as never, () => {});

    expect(res2.statusCode).toBe(429);
    expect(res2.body).toMatchObject({ tenantId: "real-tenant" });
    expect(JSON.stringify(res2.body)).not.toContain("7.7.7.7");
  });

  it("getLimit returning 0 (explicit deny-all) is honored, not confused with undefined (fall through to default) — nullish-coalescing boundary", () => {
    // `getLimit?.(key) ?? tenantCfg?.security.rateLimit ?? DEFAULT_MAX_REQUESTS` uses `??`,
    // which only falls through on null/undefined. 0 is a valid, distinct "deny everything"
    // signal a caller might return (e.g. a suspended-tenant plan check). If this were `||`
    // instead of `??`, 0 would incorrectly fall through to DEFAULT_MAX_REQUESTS (100) and
    // silently defeat the deny-all intent.
    const mw = createRateLimitMiddleware({ stage: "tenant", getLimit: () => 0 });
    const req = mockReq({ tenantId: "tenant-zero-limit" });
    const res = mockRes();
    let called = false;
    mw(req as never, res as never, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.headers["X-RateLimit-Limit"]).toBe("0");
  });

  it("getLimit returning undefined falls through to tenantConfig/DEFAULT (distinct from explicit 0)", () => {
    const mw = createRateLimitMiddleware({ stage: "tenant", getLimit: () => undefined });
    const req = mockReq({ tenantId: "tenant-undefined-limit" });
    const res = mockRes();
    let called = false;
    mw(req as never, res as never, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(res.headers["X-RateLimit-Limit"]).toBe("100"); // DEFAULT_MAX_REQUESTS
  });

  it("two-stage independence — same tenant hammered from many IPs: tenant-stage aggregates all of them, ip-stage does not block a fresh IP", () => {
    const tenantMw = createRateLimitMiddleware({ stage: "tenant", getLimit: () => 2 });
    const ipMw = createRateLimitMiddleware({ stage: "ip", getLimit: () => 100 });

    for (const ip of ["1.1.1.1", "2.2.2.2"]) {
      const req = mockReq({ tenantId: "shared-tenant", xRealIp: ip });
      tenantMw(req as never, mockRes() as never, () => {});
      ipMw(req as never, mockRes() as never, () => {});
    }

    // Tenant bucket is now exhausted (2/2) regardless of which IP sent them.
    const thirdReq = mockReq({ tenantId: "shared-tenant", xRealIp: "3.3.3.3" });
    const tenantRes = mockRes();
    let tenantCalled = false;
    tenantMw(thirdReq as never, tenantRes as never, () => {
      tenantCalled = true;
    });
    expect(tenantCalled).toBe(false);
    expect(tenantRes.statusCode).toBe(429);

    // But the fresh IP's own ip-stage bucket is untouched.
    const ipRes = mockRes();
    let ipCalled = false;
    ipMw(thirdReq as never, ipRes as never, () => {
      ipCalled = true;
    });
    expect(ipCalled).toBe(true);
  });
});
