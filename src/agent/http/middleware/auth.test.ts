// src/agent/http/middleware/auth.test.ts
// [P1] deprecated agent auth middleware の fail-closed 化テスト。
// 資格情報が全未設定でも「素通し」せず 503 で拒否すること、
// dev/test の明示 opt-in でのみバイパスできること、production では opt-in が無効なことを固定する。

import { createAuthMiddleware } from "./auth";

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
}

function makeReqRes(headers: Record<string, string> = {}) {
  const req: any = {
    path: "/x",
    method: "GET",
    headers,
    header(name: string) {
      return this.headers[name.toLowerCase()];
    },
  };
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  const next = jest.fn();
  return { req, res, next };
}

describe("createAuthMiddleware — fail-closed", () => {
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env.AGENT_API_KEY;
    delete process.env.AGENT_BASIC_USER;
    delete process.env.AGENT_BASIC_PASSWORD;
    delete process.env.ALLOW_INSECURE_AGENT_AUTH;
  });
  afterEach(() => {
    process.env = savedEnv;
  });

  it("[P1] 資格情報が全未設定 + opt-in 無し → 全リクエストを 503 で拒否（素通ししない）", () => {
    process.env.NODE_ENV = "test";
    const mw = createAuthMiddleware(makeLogger());
    const { req, res, next } = makeReqRes();
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: "auth_not_configured" });
  });

  it("[P1] 全未設定 + NODE_ENV=development + ALLOW_INSECURE_AGENT_AUTH=1 → バイパス（next）", () => {
    process.env.NODE_ENV = "development";
    process.env.ALLOW_INSECURE_AGENT_AUTH = "1";
    const mw = createAuthMiddleware(makeLogger());
    const { req, res, next } = makeReqRes();
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("[P1] 全未設定 + NODE_ENV=production + ALLOW_INSECURE_AGENT_AUTH=1 → opt-in 無効、503", () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOW_INSECURE_AGENT_AUTH = "1";
    const mw = createAuthMiddleware(makeLogger());
    const { req, res, next } = makeReqRes();
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });

  it("API Key 設定済み: 正しい x-api-key は通す / 不正は 401", () => {
    process.env.AGENT_API_KEY = "secret-key";
    const mw = createAuthMiddleware(makeLogger());

    const ok = makeReqRes({ "x-api-key": "secret-key" });
    mw(ok.req, ok.res, ok.next);
    expect(ok.next).toHaveBeenCalledTimes(1);

    const bad = makeReqRes({ "x-api-key": "wrong" });
    mw(bad.req, bad.res, bad.next);
    expect(bad.next).not.toHaveBeenCalled();
    expect(bad.res.statusCode).toBe(401);
  });

  it("Basic 認証設定済み: 正しい資格情報は通す", () => {
    process.env.AGENT_BASIC_USER = "u";
    process.env.AGENT_BASIC_PASSWORD = "p";
    const mw = createAuthMiddleware(makeLogger());
    const basic = "Basic " + Buffer.from("u:p").toString("base64");
    const { req, res, next } = makeReqRes({ authorization: basic });
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
