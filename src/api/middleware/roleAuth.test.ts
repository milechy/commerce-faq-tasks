// src/api/middleware/roleAuth.test.ts
// Phase34: ロールベース認証ミドルウェアのテスト
import type { NextFunction, Request, Response } from "express";
import {
  roleAuthMiddleware,
  requireRole,
  resolveEffectiveTenantId,
  type AuthenticatedUser,
} from "./roleAuth";

function mockReq(overrides: Record<string, unknown> = {}): Request {
  return {
    params: {},
    query: {},
    headers: {},
    body: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

const next: NextFunction = jest.fn();

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// roleAuthMiddleware
// ---------------------------------------------------------------------------
describe("roleAuthMiddleware", () => {
  it("sets anonymous role when supabaseUser is not set", () => {
    const req = mockReq();
    const res = mockRes();
    roleAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).user).toMatchObject({
      id: "",
      email: "",
      role: "anonymous",
      tenantId: null,
    });
  });

  it("sets super_admin role from app_metadata", () => {
    const req = mockReq({
      supabaseUser: {
        sub: "user-001",
        email: "admin@example.com",
        app_metadata: { role: "super_admin" },
      },
    });
    const res = mockRes();
    roleAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    const user: AuthenticatedUser = (req as any).user;
    expect(user.role).toBe("super_admin");
    expect(user.id).toBe("user-001");
    expect(user.email).toBe("admin@example.com");
    expect(user.tenantId).toBeNull();
  });

  it("sets client_admin role and tenantId from app_metadata", () => {
    const req = mockReq({
      supabaseUser: {
        sub: "user-002",
        email: "client@example.com",
        app_metadata: { role: "client_admin", tenant_id: "tenant-abc" },
      },
    });
    const res = mockRes();
    roleAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    const user: AuthenticatedUser = (req as any).user;
    expect(user.role).toBe("client_admin");
    expect(user.tenantId).toBe("tenant-abc");
  });

  it("[攻撃防止] user_metadata.role='super_admin' は anonymous になる (クライアント制御可能)", () => {
    const req = mockReq({
      supabaseUser: {
        sub: "attacker-001",
        email: "attacker@example.com",
        user_metadata: { role: "super_admin" },
        // app_metadata.role は未設定
      },
    });
    const res = mockRes();
    roleAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    const user: AuthenticatedUser = (req as any).user;
    expect(user.role).toBe("anonymous");
    expect(user.tenantId).toBeNull();
  });

  it("[攻撃防止] client_admin + user_metadata.tenant_id のみ → fail-closed で 403", () => {
    const req = mockReq({
      supabaseUser: {
        sub: "attacker-002",
        email: "attacker@example.com",
        app_metadata: { role: "client_admin" },
        user_metadata: { tenant_id: "injected-tenant" },
        // app_metadata.tenant_id は未設定
      },
    });
    const res = mockRes();
    roleAuthMiddleware(req, res, next);

    // user_metadata.tenant_id は信頼源として扱われないため app_metadata.tenant_id が欠損
    // → client_admin + tenantId=null → fail-closed で 403
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.any(String),
    }));
  });

  it("[攻撃防止] app_metadata なし + user_metadata のみ → anonymous / null", () => {
    const req = mockReq({
      supabaseUser: {
        sub: "attacker-003",
        email: "attacker@example.com",
        user_metadata: { role: "client_admin", tenant_id: "attacker-tenant" },
        // app_metadata 自体なし
      },
    });
    const res = mockRes();
    roleAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    const user: AuthenticatedUser = (req as any).user;
    expect(user.role).toBe("anonymous");
    expect(user.tenantId).toBeNull();
  });

  // ── fail-closed: client_admin without tenant_id ─────────────────────────

  it("[X] client_admin + app_metadata.tenant_id=undefined → 403 (fail-closed)", () => {
    const req = mockReq({
      supabaseUser: {
        sub: "user-010",
        email: "cadmin@example.com",
        app_metadata: { role: "client_admin" },
        // tenant_id 未設定
      },
    });
    const res = mockRes();
    roleAuthMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("[Y] client_admin + app_metadata.tenant_id='' → 403 (fail-closed)", () => {
    const req = mockReq({
      supabaseUser: {
        sub: "user-011",
        email: "cadmin2@example.com",
        app_metadata: { role: "client_admin", tenant_id: "" },
      },
    });
    const res = mockRes();
    roleAuthMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("[Z] client_admin + app_metadata.tenant_id='t1' → next() 呼ばれる", () => {
    const req = mockReq({
      supabaseUser: {
        sub: "user-012",
        email: "cadmin3@example.com",
        app_metadata: { role: "client_admin", tenant_id: "t1" },
      },
    });
    const res = mockRes();
    roleAuthMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    const user: AuthenticatedUser = (req as any).user;
    expect(user.role).toBe("client_admin");
    expect(user.tenantId).toBe("t1");
  });

  it("[W] super_admin + tenant_id なし → next() 呼ばれる (グローバル操作は影響なし)", () => {
    const req = mockReq({
      supabaseUser: {
        sub: "user-013",
        email: "superadmin@example.com",
        app_metadata: { role: "super_admin" },
        // tenant_id なし — super_admin は全テナント対象
      },
    });
    const res = mockRes();
    roleAuthMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    const user: AuthenticatedUser = (req as any).user;
    expect(user.role).toBe("super_admin");
    expect(user.tenantId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// requireRole
// ---------------------------------------------------------------------------
describe("requireRole", () => {
  it("allows when role matches", () => {
    const req = mockReq({
      user: { id: "u1", email: "e@e.com", role: "super_admin", tenantId: null },
    });
    const res = mockRes();
    requireRole("super_admin")(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows when role is in the list", () => {
    const req = mockReq({
      user: { id: "u2", email: "e@e.com", role: "client_admin", tenantId: "t1" },
    });
    const res = mockRes();
    requireRole("super_admin", "client_admin")(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("returns 403 when role does not match", () => {
    const req = mockReq({
      user: { id: "u3", email: "e@e.com", role: "client_admin", tenantId: "t1" },
    });
    const res = mockRes();
    requireRole("super_admin")(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect((res.json as jest.Mock).mock.calls[0][0]).toMatchObject({
      error: "forbidden",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when user is anonymous", () => {
    const req = mockReq({
      user: { id: "", email: "", role: "anonymous", tenantId: null },
    });
    const res = mockRes();
    requireRole("super_admin", "client_admin")(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 403 when user is undefined", () => {
    const req = mockReq();
    const res = mockRes();
    requireRole("super_admin")(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveTenantId
// ---------------------------------------------------------------------------
// アバター生成系4ルート(fal/generate, generate-image, match-voice,
// generate-prompt)が個別に app_metadata.tenant_id のみを見ており、
// super_adminのpreviewMode中に ?tenant= を無視して空テナントで課金・
// ストレージ書き込みしていた欠陥の是正で導入。routes.ts:647 の既存パターンを
// 共有ヘルパーとして切り出したもの。
describe("resolveEffectiveTenantId", () => {
  it("super_adminは?tenant=クエリで操作対象テナントを上書きできる", () => {
    const req = mockReq({
      supabaseUser: { app_metadata: { role: "super_admin" } },
      query: { tenant: "tenant-b" },
    });
    expect(resolveEffectiveTenantId(req)).toBe("tenant-b");
  });

  it("super_adminが?tenant=を付けなければ従来通り空文字のまま(400ガードは別レイヤーの責務)", () => {
    const req = mockReq({
      supabaseUser: { app_metadata: { role: "super_admin" } },
      query: {},
    });
    expect(resolveEffectiveTenantId(req)).toBe("");
  });

  it("[越権防止] client_adminが?tenant=を付けても無視され、JWTの自テナントが使われる", () => {
    const req = mockReq({
      supabaseUser: { app_metadata: { role: "client_admin", tenant_id: "tenant-a" } },
      query: { tenant: "tenant-b" },
    });
    expect(resolveEffectiveTenantId(req)).toBe("tenant-a");
  });

  it("client_adminは?tenant=なしなら自テナントをそのまま使う", () => {
    const req = mockReq({
      supabaseUser: { app_metadata: { role: "client_admin", tenant_id: "tenant-a" } },
      query: {},
    });
    expect(resolveEffectiveTenantId(req)).toBe("tenant-a");
  });

  it("supabaseUserが無ければ空文字を返す(anonymous)", () => {
    const req = mockReq({ query: {} });
    expect(resolveEffectiveTenantId(req)).toBe("");
  });

  // ── 境界値・異常系 ──────────────────────────────────────────────────────
  // 返り値は trackUsage の請求先テナントと Supabase Storage のパス
  // (`${tenantId}/${filename}`) の両方に直接入る。string 以外や空白だけの値が
  // 素通りすると、請求先が実在しないテナントになる/バケットの意図しない場所へ
  // 書かれる、という形で静かに壊れる。呼び出し側の `if (!tenantId)` ガードは
  // 空文字しか弾けないため、ここで型と中身を確定させておく必要がある。

  it("[クエリ汚染] ?tenant= を複数回指定されても配列を返さない(Expressは配列にする)", () => {
    // `?tenant=a&tenant=b` を Express は ['a','b'] としてパースする。
    // `as string` のキャストは実行時には何も保証しないため、素通りすると
    // `${tenantId}/...` が "a,b/..." というパスになり、trackUsage の
    // tenantId にも配列が入る。
    const req = mockReq({
      supabaseUser: { app_metadata: { role: "super_admin" } },
      query: { tenant: ["tenant-a", "tenant-b"] },
    });
    const result = resolveEffectiveTenantId(req);
    expect(typeof result).toBe("string");
    // 曖昧な指定は採用せず、テナント未指定として扱う(呼び出し側の400ガードに委ねる)
    expect(result).toBe("");
  });

  it("[クエリ汚染] ?tenant[x]=y のようなオブジェクト指定も文字列として扱わない", () => {
    const req = mockReq({
      supabaseUser: { app_metadata: { role: "super_admin" } },
      query: { tenant: { x: "y" } },
    });
    const result = resolveEffectiveTenantId(req);
    expect(typeof result).toBe("string");
    expect(result).toBe("");
  });

  it("[空白のみ] ?tenant=%20%20 は未指定として扱う(バケット直下に空白ディレクトリを作らない)", () => {
    // "   " は truthy なので、trimしないと呼び出し側の `if (!tenantId)` を
    // すり抜けて `"   /fal-xxx.jpg"` というパスで実際に書き込まれてしまう。
    const req = mockReq({
      supabaseUser: { app_metadata: { role: "super_admin" } },
      query: { tenant: "   " },
    });
    expect(resolveEffectiveTenantId(req)).toBe("");
  });

  it("[空白混じり] 前後の空白は落として返す", () => {
    const req = mockReq({
      supabaseUser: { app_metadata: { role: "super_admin" } },
      query: { tenant: "  tenant-b  " },
    });
    expect(resolveEffectiveTenantId(req)).toBe("tenant-b");
  });

  it("[空白のみ] client_admin の JWT テナントが空白だけの場合も未指定として扱う", () => {
    const req = mockReq({
      supabaseUser: { app_metadata: { role: "client_admin", tenant_id: "   " } },
      query: {},
    });
    expect(resolveEffectiveTenantId(req)).toBe("");
  });

  it("[優先順位] super_adminが自身のtenant_idを持っていても ?tenant= が優先される", () => {
    // R2C運用者のJWTにtenant_idが入っているケース。previewMode中の操作対象は
    // あくまで ?tenant= 側なので、JWT側に引きずられてはいけない。
    const req = mockReq({
      supabaseUser: { app_metadata: { role: "super_admin", tenant_id: "r2c-internal" } },
      query: { tenant: "tenant-b" },
    });
    expect(resolveEffectiveTenantId(req)).toBe("tenant-b");
  });

  it("[フォールバック] super_adminが?tenant=を空文字で送ったらJWTのtenant_idに落ちる", () => {
    const req = mockReq({
      supabaseUser: { app_metadata: { role: "super_admin", tenant_id: "r2c-internal" } },
      query: { tenant: "" },
    });
    expect(resolveEffectiveTenantId(req)).toBe("r2c-internal");
  });

  it("[越権防止] client_adminには配列汚染も効かず、常に自テナントを返す", () => {
    const req = mockReq({
      supabaseUser: { app_metadata: { role: "client_admin", tenant_id: "tenant-a" } },
      query: { tenant: ["tenant-b", "tenant-c"] },
    });
    expect(resolveEffectiveTenantId(req)).toBe("tenant-a");
  });

  it("[攻撃防止] user_metadata.role='super_admin' では ?tenant= を効かせない", () => {
    // user_metadata はクライアント制御可能。ここで super_admin と誤認すると
    // 任意テナントへの課金付け替えが誰でもできてしまう。
    const req = mockReq({
      supabaseUser: {
        app_metadata: { role: "client_admin", tenant_id: "tenant-a" },
        user_metadata: { role: "super_admin" },
      },
      query: { tenant: "tenant-b" },
    });
    expect(resolveEffectiveTenantId(req)).toBe("tenant-a");
  });
});

// NOTE: requireOwnTenant() ヘルパー削除に伴い、対応する describe ブロックは撤去。
// テナント分離の retest は per-tenant ルートのテスト（例: knowledgeGapAuthGuard.test.ts,
// evaluationsAuthGuard.test.ts, optionsAuthGuard.test.ts 等）でカバーされている。
