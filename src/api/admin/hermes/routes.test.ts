// src/api/admin/hermes/routes.test.ts
// Phase74: Hermes Agent Admin API — 認可ガード + 越境防止テスト

jest.mock("../../../admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));

const mockListProposals = jest.fn();
const mockGetProposalById = jest.fn();
const mockUpdateProposalStatus = jest.fn();

jest.mock("../../../agent/hermes/proposalRepository", () => ({
  createHermesProposalRepository: jest.fn(() => ({
    listProposals: mockListProposals,
    getProposalById: mockGetProposalById,
    updateProposalStatus: mockUpdateProposalStatus,
  })),
}));

import express from "express";
import request from "supertest";
import { registerHermesRoutes } from "./routes";

const FAKE_DB = { query: jest.fn() } as any;

function makeApp(user: Record<string, unknown> | null, db: unknown = FAKE_DB) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = user;
    next();
  });
  registerHermesRoutes(app, db as any);
  return app;
}

const SUPER_ADMIN = { app_metadata: { role: "super_admin", tenant_id: null }, email: "root@example.com" };
const CLIENT_ADMIN = { app_metadata: { role: "client_admin", tenant_id: "carnation" }, email: "owner@carnation.example" };

const ALL_ROUTES = [
  { method: "get" as const, path: "/v1/admin/hermes/proposals" },
  { method: "post" as const, path: "/v1/admin/hermes/proposals/1/approve" },
  { method: "post" as const, path: "/v1/admin/hermes/proposals/1/reject" },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockListProposals.mockResolvedValue([]);
  mockGetProposalById.mockResolvedValue(null);
  mockUpdateProposalStatus.mockResolvedValue(null);
});

describe("認可ガード(ALLOWED_ROLES)", () => {
  ALL_ROUTES.forEach(({ method, path }) => {
    it(`${method.toUpperCase()} ${path} — viewer → 403`, async () => {
      const app = makeApp({ app_metadata: { role: "viewer", tenant_id: "t1" }, email: "v@t.com" });
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(403);
    });

    it(`${method.toUpperCase()} ${path} — stale JWT(user_metadataのみ) → 403`, async () => {
      const app = makeApp({ user_metadata: { role: "super_admin", tenant_id: "t1" }, email: "v@t.com" });
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(403);
    });

    it(`${method.toUpperCase()} ${path} — 未認証(null) → 403`, async () => {
      const app = makeApp(null);
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(403);
    });
  });
});

describe("GET /v1/admin/hermes/proposals", () => {
  it("db未接続なら503", async () => {
    const app = makeApp(SUPER_ADMIN, null);
    const res = await request(app).get("/v1/admin/hermes/proposals");
    expect(res.status).toBe(503);
  });

  it("super_adminはフィルタ無しで全件取得できる", async () => {
    mockListProposals.mockResolvedValue([{ id: "1", scope: "global" }]);
    const app = makeApp(SUPER_ADMIN);

    const res = await request(app).get("/v1/admin/hermes/proposals");

    expect(res.status).toBe(200);
    expect(res.body.proposals).toHaveLength(1);
    expect(mockListProposals).toHaveBeenCalledWith({
      scope: undefined,
      tenantId: undefined,
      status: undefined,
    });
  });

  it("super_adminはscope/tenant_id/statusで絞り込める", async () => {
    const app = makeApp(SUPER_ADMIN);

    await request(app).get(
      "/v1/admin/hermes/proposals?scope=tenant&tenant_id=carnation&status=pending",
    );

    expect(mockListProposals).toHaveBeenCalledWith({
      scope: "tenant",
      tenantId: "carnation",
      status: "pending",
    });
  });

  it("不正なscopeは400", async () => {
    const app = makeApp(SUPER_ADMIN);
    const res = await request(app).get("/v1/admin/hermes/proposals?scope=bogus");
    expect(res.status).toBe(400);
  });

  it("不正なstatusは400", async () => {
    const app = makeApp(SUPER_ADMIN);
    const res = await request(app).get("/v1/admin/hermes/proposals?status=bogus");
    expect(res.status).toBe(400);
  });

  it("client_adminがscope=globalを要求すると403(匿名横断提案はsuper_admin専用)", async () => {
    const app = makeApp(CLIENT_ADMIN);
    const res = await request(app).get("/v1/admin/hermes/proposals?scope=global");
    expect(res.status).toBe(403);
    expect(mockListProposals).not.toHaveBeenCalled();
  });

  it("client_adminが他テナントのtenant_idを指定すると403(越境防止)", async () => {
    const app = makeApp(CLIENT_ADMIN);
    const res = await request(app).get("/v1/admin/hermes/proposals?tenant_id=other-tenant");
    expect(res.status).toBe(403);
  });

  it("client_adminはフィルタ無しでも自テナントのtenantスコープのみに強制される", async () => {
    const app = makeApp(CLIENT_ADMIN);

    await request(app).get("/v1/admin/hermes/proposals");

    expect(mockListProposals).toHaveBeenCalledWith({
      scope: "tenant",
      tenantId: "carnation",
      status: undefined,
    });
  });
});

describe("POST /v1/admin/hermes/proposals/:id/approve", () => {
  it("db未接続なら503", async () => {
    const app = makeApp(SUPER_ADMIN, null);
    const res = await request(app).post("/v1/admin/hermes/proposals/1/approve");
    expect(res.status).toBe(503);
  });

  it("提案が存在しなければ404", async () => {
    mockGetProposalById.mockResolvedValue(null);
    const app = makeApp(SUPER_ADMIN);

    const res = await request(app).post("/v1/admin/hermes/proposals/999/approve");

    expect(res.status).toBe(404);
    expect(mockUpdateProposalStatus).not.toHaveBeenCalled();
  });

  it("client_adminがglobal提案を承認しようとすると403", async () => {
    mockGetProposalById.mockResolvedValue({ id: "1", scope: "global", tenantId: null });
    const app = makeApp(CLIENT_ADMIN);

    const res = await request(app).post("/v1/admin/hermes/proposals/1/approve");

    expect(res.status).toBe(403);
    expect(mockUpdateProposalStatus).not.toHaveBeenCalled();
  });

  it("client_adminが他テナントのtenant提案を承認しようとすると403(越境防止)", async () => {
    mockGetProposalById.mockResolvedValue({ id: "1", scope: "tenant", tenantId: "other-tenant" });
    const app = makeApp(CLIENT_ADMIN);

    const res = await request(app).post("/v1/admin/hermes/proposals/1/approve");

    expect(res.status).toBe(403);
    expect(mockUpdateProposalStatus).not.toHaveBeenCalled();
  });

  it("client_adminは自テナントのtenant提案を承認でき、decided_byにemailが記録される", async () => {
    mockGetProposalById.mockResolvedValue({ id: "1", scope: "tenant", tenantId: "carnation" });
    mockUpdateProposalStatus.mockResolvedValue({ id: "1", status: "approved" });
    const app = makeApp(CLIENT_ADMIN);

    const res = await request(app).post("/v1/admin/hermes/proposals/1/approve");

    expect(res.status).toBe(200);
    expect(mockUpdateProposalStatus).toHaveBeenCalledWith(
      "1",
      "approved",
      "owner@carnation.example",
    );
  });

  it("super_adminはどのscope/tenantの提案でも承認できる", async () => {
    mockGetProposalById.mockResolvedValue({ id: "1", scope: "global", tenantId: null });
    mockUpdateProposalStatus.mockResolvedValue({ id: "1", status: "approved" });
    const app = makeApp(SUPER_ADMIN);

    const res = await request(app).post("/v1/admin/hermes/proposals/1/approve");

    expect(res.status).toBe(200);
  });

  it("updateProposalStatusがnullを返す(競合等)場合は404", async () => {
    mockGetProposalById.mockResolvedValue({ id: "1", scope: "global", tenantId: null });
    mockUpdateProposalStatus.mockResolvedValue(null);
    const app = makeApp(SUPER_ADMIN);

    const res = await request(app).post("/v1/admin/hermes/proposals/1/approve");

    expect(res.status).toBe(404);
  });
});

describe("POST /v1/admin/hermes/proposals/:id/reject", () => {
  it("super_adminが却下でき、statusに'rejected'が渡る", async () => {
    mockGetProposalById.mockResolvedValue({ id: "1", scope: "global", tenantId: null });
    mockUpdateProposalStatus.mockResolvedValue({ id: "1", status: "rejected" });
    const app = makeApp(SUPER_ADMIN);

    const res = await request(app).post("/v1/admin/hermes/proposals/1/reject");

    expect(res.status).toBe(200);
    expect(mockUpdateProposalStatus).toHaveBeenCalledWith("1", "rejected", "root@example.com");
  });
});
