// src/admin/http/supabaseAuthMiddleware.test.ts
// D1c: 8箇所のインラインauthコピーを統合した共有ミドルウェアの直接テスト。
// 分岐: development単一条件のdevバイパス / secret未設定時のproduction限定fail-closed(503) /
//       それ以外のfail-open(warn) / 正規JWT検証 / 不正トークン401。
// 統合前に各所へ個別に存在していたコピーの回帰を防ぐため、ここで一括固定する。

jest.mock("../../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import jwt from "jsonwebtoken";
import { supabaseAuthMiddleware } from "./supabaseAuthMiddleware";

function makeReqRes(headers: Record<string, string> = {}) {
  const req: any = { headers };
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

describe("supabaseAuthMiddleware", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  describe("development: dev-decodeバイパス（単一条件 NODE_ENV==='development'）", () => {
    beforeEach(() => {
      process.env.NODE_ENV = "development";
    });

    it("Bearerトークンを署名検証せずdecodeしreq.supabaseUserにセットして通す", () => {
      const token = Buffer.from(JSON.stringify({ app_metadata: { role: "super_admin" } })).toString("base64url");
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const fakeJwt = `${header}.${token}.no-real-signature`;
      const { req, res, next } = makeReqRes({ authorization: `Bearer ${fakeJwt}` });

      supabaseAuthMiddleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.supabaseUser).toMatchObject({ app_metadata: { role: "super_admin" } });
    });

    it("decode不能な不正トークンでも例外を投げず、req.supabaseUserを特権オブジェクトにせずに通す", () => {
      const { req, res, next } = makeReqRes({ authorization: "Bearer not-a-valid-jwt-structure" });

      expect(() => supabaseAuthMiddleware(req, res, next)).not.toThrow();
      expect(next).toHaveBeenCalledTimes(1);
      // jwt.decode()は不正な構造に対して例外ではなくnullを返す（jsonwebtokenの仕様）。
      // ここが undefined でも null でも、後続のroleAuthMiddlewareはどちらも
      // role:"anonymous" として扱うため安全だが、object化されて role を誤取得しないことが本旨。
      expect(req.supabaseUser).toBeFalsy();
    });

    it("Bearerヘッダなし・x-api-keyありは通す", () => {
      const { req, res, next } = makeReqRes({ "x-api-key": "some-key" });
      supabaseAuthMiddleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("Bearerヘッダなし・x-api-keyなしは401", () => {
      const { req, res, next } = makeReqRes({});
      supabaseAuthMiddleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });

    it("NODE_ENV==='development'かつSUPABASE_JWT_SECRETが設定されていても、devバイパスが優先される（本番相当の誤設定を検知する回帰テスト）", () => {
      process.env.SUPABASE_JWT_SECRET = "real-secret";
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const body = Buffer.from(JSON.stringify({ app_metadata: { role: "client_admin", tenant_id: "t1" } })).toString("base64url");
      const { req, res, next } = makeReqRes({ authorization: `Bearer ${header}.${body}.unsigned` });

      supabaseAuthMiddleware(req, res, next);

      // devバイパス経路（署名検証なしでdecode）が発動していること = 本番運用ではNODE_ENVを
      // developmentにしないことが唯一の防御線であるという設計上の前提を明示する
      expect(next).toHaveBeenCalledTimes(1);
      expect(req.supabaseUser).toMatchObject({ app_metadata: { role: "client_admin" } });
    });
  });

  describe("NODE_ENV!=='development'（production/test/未設定） かつ SUPABASE_JWT_SECRET未設定", () => {
    it("production: 503 fail-closed で next() を呼ばない", () => {
      process.env.NODE_ENV = "production";
      delete process.env.SUPABASE_JWT_SECRET;
      const { req, res, next } = makeReqRes({ authorization: "Bearer whatever" });

      supabaseAuthMiddleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual({ error: "auth_not_configured" });
    });

    it("test: fail-open（warnして next()）、かつ req.supabaseUser はセットされない", () => {
      process.env.NODE_ENV = "test";
      delete process.env.SUPABASE_JWT_SECRET;
      const { req, res, next } = makeReqRes({ authorization: "Bearer whatever" });

      supabaseAuthMiddleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
      // fail-openで通過した場合、req.supabaseUserは未設定のまま —
      // 後続のroleAuthMiddlewareはこれを role:"anonymous" として扱う必要がある。
      // ここが未設定のまま特権ロールとして誤解釈されないことが本テストの主眼。
      expect(req.supabaseUser).toBeUndefined();
    });

    it("NODE_ENV未設定（undefined）: productionではないため fail-open で next()", () => {
      delete process.env.NODE_ENV;
      delete process.env.SUPABASE_JWT_SECRET;
      const { req, res, next } = makeReqRes({ authorization: "Bearer whatever" });

      supabaseAuthMiddleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.supabaseUser).toBeUndefined();
    });
  });

  describe("NODE_ENV!=='development' かつ SUPABASE_JWT_SECRET設定済み: 通常のJWT検証", () => {
    const SECRET = "test-secret-value";

    beforeEach(() => {
      process.env.NODE_ENV = "test";
      process.env.SUPABASE_JWT_SECRET = SECRET;
    });

    it("正しく署名されたトークンはreq.supabaseUserにdecoded payloadをセットして通す", () => {
      const token = jwt.sign({ app_metadata: { role: "super_admin" }, sub: "user-1" }, SECRET);
      const { req, res, next } = makeReqRes({ authorization: `Bearer ${token}` });

      supabaseAuthMiddleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.supabaseUser).toMatchObject({ app_metadata: { role: "super_admin" }, sub: "user-1" });
    });

    it("別の鍵で署名されたトークン（鍵不一致）は401", () => {
      const token = jwt.sign({ app_metadata: { role: "super_admin" } }, "wrong-secret");
      const { req, res, next } = makeReqRes({ authorization: `Bearer ${token}` });

      supabaseAuthMiddleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });

    it("期限切れトークンは401", () => {
      const token = jwt.sign({ app_metadata: { role: "super_admin" } }, SECRET, { expiresIn: -10 });
      const { req, res, next } = makeReqRes({ authorization: `Bearer ${token}` });

      supabaseAuthMiddleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });

    it("client_adminも正しく通る", () => {
      const token = jwt.sign({ app_metadata: { role: "client_admin", tenant_id: "t1" } }, SECRET);
      const { req, res, next } = makeReqRes({ authorization: `Bearer ${token}` });

      supabaseAuthMiddleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.supabaseUser).toMatchObject({ app_metadata: { role: "client_admin" } });
    });
  });

  describe("isAdminUsableToken配線: 署名は正しいが管理面で使えないトークンは403", () => {
    const SECRET = "test-secret-value";

    beforeEach(() => {
      process.env.NODE_ENV = "test";
      process.env.SUPABASE_JWT_SECRET = SECRET;
    });

    it("purposeクレーム保持トークン（widget-session等、同じsecretで署名されうる）は403", () => {
      const token = jwt.sign({ sub: "t1", purpose: "widget-session" }, SECRET);
      const { req, res, next } = makeReqRes({ authorization: `Bearer ${token}` });

      supabaseAuthMiddleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(req.supabaseUser).toBeUndefined();
    });

    it("purposeクレーム保持トークン（chat-test）は403", () => {
      const token = jwt.sign({ tenant_id: "t1", purpose: "chat-test" }, SECRET);
      const { req, res, next } = makeReqRes({ authorization: `Bearer ${token}` });

      supabaseAuthMiddleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    it("role='anon'（トップレベル）は403", () => {
      const token = jwt.sign({ sub: "u1", role: "anon" }, SECRET);
      const { req, res, next } = makeReqRes({ authorization: `Bearer ${token}` });

      supabaseAuthMiddleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    it("app_metadata.role='anon'は403", () => {
      const token = jwt.sign({ sub: "u1", app_metadata: { role: "anon" } }, SECRET);
      const { req, res, next } = makeReqRes({ authorization: `Bearer ${token}` });

      supabaseAuthMiddleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    it("app_metadata.roleが未知の値（super_admin/client_admin以外）は403", () => {
      const token = jwt.sign({ sub: "u1", app_metadata: { role: "viewer" } }, SECRET);
      const { req, res, next } = makeReqRes({ authorization: `Bearer ${token}` });

      supabaseAuthMiddleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    it("Bearerトークンなしは401", () => {
      const { req, res, next } = makeReqRes({});
      supabaseAuthMiddleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: "Missing Bearer token" });
    });

    it("構造上デコード不能な文字列（jwt.verifyが例外を投げる）は401であり、例外がexpressのエラーハンドラまで伝播しない", () => {
      const { req, res, next } = makeReqRes({ authorization: "Bearer not.a.jwt" });
      expect(() => supabaseAuthMiddleware(req, res, next)).not.toThrow();
      expect(res.statusCode).toBe(401);
    });

    it("algなしの不正トークン(alg:none偽装)は署名検証で拒否される", () => {
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const body = Buffer.from(JSON.stringify({ app_metadata: { role: "super_admin" } })).toString("base64url");
      const { req, res, next } = makeReqRes({ authorization: `Bearer ${header}.${body}.` });

      supabaseAuthMiddleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });
  });
});
