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

  it("key namespace collision — a tenantId equal to an ip-stage key string can collide with that IP's bucket", () => {
    // stage:'ip' keys are prefixed "ip:<addr>"; stage:'tenant' keys are the
    // raw tenantId with NO prefix. A tenant literally named "ip:1.2.3.4"
    // collides with the rate-limit bucket for that IP address, since both
    // stages share the same module-level `store`. tenantId is client-chosen
    // at tenant-creation time (see tenants/routes.ts), so this is reachable,
    // not merely theoretical.
    const ipMw = createRateLimitMiddleware({ stage: "ip", getLimit: () => 1 });
    const tenantMw = createRateLimitMiddleware({ stage: "tenant", getLimit: () => 1 });

    const ipReq = mockReq({ xRealIp: "5.5.5.5" });
    const ipRes = mockRes();
    ipMw(ipReq as never, ipRes as never, () => {});
    expect(ipRes.statusCode).toBe(200); // consumes the "ip:5.5.5.5" bucket

    const collidingTenantReq = mockReq({ tenantId: "ip:5.5.5.5" });
    const tenantRes = mockRes();
    let calledTenant = false;
    tenantMw(collidingTenantReq as never, tenantRes as never, () => {
      calledTenant = true;
    });
    // Demonstrates the collision: a brand-new tenant is blocked on its very
    // first tenant-scoped request because an unrelated IP bucket of the
    // same name was already exhausted.
    expect(calledTenant).toBe(false);
  });

  it("getLimit receives the resolved key (IP-prefixed for stage:'ip', raw tenantId for stage:'tenant')", () => {
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

    expect(seenKeys).toEqual(["ip:8.8.8.8", "tenantX"]);
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
