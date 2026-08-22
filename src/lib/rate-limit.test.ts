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
});
