// src/api/admin/tenants/superAdminMiddleware.test.ts
// Phase69-1.5: superAdminMiddleware の信頼境界テスト

import type { NextFunction, Request, Response } from "express";
import { superAdminMiddleware } from "./superAdminMiddleware";

function mockReq(supabaseUser?: unknown): Request {
  return { supabaseUser } as unknown as Request;
}

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

const next: NextFunction = jest.fn();

beforeEach(() => jest.clearAllMocks());

describe("superAdminMiddleware", () => {
  beforeAll(() => {
    process.env.NODE_ENV = "test";
  });

  // ── 正常系 ──────────────────────────────────────────────────────────────────

  it("app_metadata.role='super_admin' → next() を呼ぶ", () => {
    const req = mockReq({ app_metadata: { role: "super_admin" } });
    superAdminMiddleware(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it("認証なし (supabaseUser なし) → 401", () => {
    const req = mockReq(undefined);
    const res = mockRes();
    superAdminMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("app_metadata.role='client_admin' → 403", () => {
    const req = mockReq({ app_metadata: { role: "client_admin" } });
    const res = mockRes();
    superAdminMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  // ── [攻撃シナリオ] 信頼境界テスト ─────────────────────────────────────────

  it("[攻撃防止] user_metadata.role='super_admin', app_metadata なし → 403", () => {
    const req = mockReq({
      user_metadata: { role: "super_admin" },
      // app_metadata.role は未設定
    });
    const res = mockRes();
    superAdminMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("[攻撃防止] top-level role='super_admin', app_metadata なし → 403", () => {
    const req = mockReq({
      role: "super_admin",
      // app_metadata.role は未設定
    });
    const res = mockRes();
    superAdminMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("[攻撃防止] app_metadata.role='viewer', user_metadata.role='super_admin' → 403", () => {
    const req = mockReq({
      app_metadata: { role: "viewer" },
      user_metadata: { role: "super_admin" },
    });
    const res = mockRes();
    superAdminMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
