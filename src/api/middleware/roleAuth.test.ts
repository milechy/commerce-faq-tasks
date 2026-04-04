// src/api/middleware/roleAuth.test.ts
// Phase34: ロールベース認証ミドルウェアのテスト
import type { NextFunction, Request, Response } from "express";
import {
  roleAuthMiddleware,
  requireRole,
  requireOwnTenant,
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

  it("falls back to user_metadata.tenant_id when app_metadata.tenant_id is absent", () => {
    const req = mockReq({
      supabaseUser: {
        sub: "user-003",
        email: "client2@example.com",
        app_metadata: { role: "client_admin" },
        user_metadata: { tenant_id: "tenant-from-user-meta" },
      },
    });
    const res = mockRes();
    roleAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    const user: AuthenticatedUser = (req as any).user;
    expect(user.role).toBe("client_admin");
    expect(user.tenantId).toBe("tenant-from-user-meta");
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
// requireOwnTenant
// ---------------------------------------------------------------------------
describe("requireOwnTenant", () => {
  it("allows super_admin to access any tenant", () => {
    const req = mockReq({
      user: { id: "u1", email: "a@a.com", role: "super_admin", tenantId: null },
      query: { tenant: "some-other-tenant" },
    });
    const res = mockRes();
    requireOwnTenant()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows client_admin to access own tenant via query param", () => {
    const req = mockReq({
      user: { id: "u2", email: "c@c.com", role: "client_admin", tenantId: "tenant-xyz" },
      query: { tenant: "tenant-xyz" },
    });
    const res = mockRes();
    requireOwnTenant()(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("returns 403 when client_admin accesses another tenant", () => {
    const req = mockReq({
      user: { id: "u2", email: "c@c.com", role: "client_admin", tenantId: "tenant-xyz" },
      query: { tenant: "other-tenant" },
    });
    const res = mockRes();
    requireOwnTenant()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect((res.json as jest.Mock).mock.calls[0][0]).toMatchObject({
      error: "forbidden",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("auto-injects tenantId when client_admin provides no tenant param", () => {
    const req = mockReq({
      user: { id: "u2", email: "c@c.com", role: "client_admin", tenantId: "tenant-xyz" },
      query: {},
    });
    const res = mockRes();
    requireOwnTenant()(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).query.tenant).toBe("tenant-xyz");
  });

  it("allows client_admin access when tenant matches x-tenant-id header", () => {
    const req = mockReq({
      user: { id: "u2", email: "c@c.com", role: "client_admin", tenantId: "tenant-abc" },
      query: {},
      headers: { "x-tenant-id": "tenant-abc" },
    });
    const res = mockRes();
    requireOwnTenant()(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("returns 403 when client_admin header tenant mismatches", () => {
    const req = mockReq({
      user: { id: "u2", email: "c@c.com", role: "client_admin", tenantId: "tenant-abc" },
      query: {},
      headers: { "x-tenant-id": "tenant-other" },
    });
    const res = mockRes();
    requireOwnTenant()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});
