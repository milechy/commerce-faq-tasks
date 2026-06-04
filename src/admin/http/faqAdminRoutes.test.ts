// src/admin/http/faqAdminRoutes.test.ts
// fix(security/HIGH): /admin/faqs 認証・テナント分離テスト

jest.mock("../../lib/db", () => ({
  pool: { query: jest.fn() },
}));
jest.mock("../../agent/llm/openaiEmbeddingClient", () => ({
  embedText: jest.fn().mockResolvedValue(Array.from({ length: 1536 }, () => 0)),
}));
jest.mock("../../search/langIndex", () => ({
  resolveFaqWriteIndex: jest.fn(() => "faq_tenant-a"),
}));
jest.mock("../../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// supabaseAuthMiddleware: Bearer トークンの中身 (base64 JSON) を req.supabaseUser にセット
// 無しまたは不正 → 401
jest.mock("./supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (req: any, res: any, next: any) => {
    const auth: string = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing Bearer token" });
    }
    try {
      req.supabaseUser = JSON.parse(
        Buffer.from(auth.slice(7), "base64").toString("utf8")
      );
      next();
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }
  },
}));

import express from "express";
import request from "supertest";
import { pool } from "../../lib/db";
import { registerFaqAdminRoutes } from "./faqAdminRoutes";

const mockQuery = (pool as unknown as { query: jest.Mock }).query;

function makeApp() {
  const app = express();
  app.use(express.json());
  registerFaqAdminRoutes(app);
  return app;
}

function bearerOf(user: object): string {
  return `Bearer ${Buffer.from(JSON.stringify(user)).toString("base64")}`;
}

const SUPER_ADMIN = { app_metadata: { role: "super_admin" } };
const CLIENT_A    = { app_metadata: { role: "client_admin", tenant_id: "tenant-a" } };
const ANONYMOUS   = { app_metadata: { role: "anonymous",   tenant_id: "tenant-a" } };

const FAQ_ROW = {
  id: 1, tenant_id: "tenant-a", question: "q", answer: "a",
  category: null, es_doc_id: null, tags: null, is_published: true,
  created_at: "", updated_at: "",
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rowCount: 1, rows: [FAQ_ROW] });
});

// ---------------------------------------------------------------------------
// 認証必須化 — Bearer なし → 401 (5ルート代表で GET/POST/DELETE を検証)
// ---------------------------------------------------------------------------
describe("認証 — Bearer トークン未送信 → 401", () => {
  it("GET /admin/faqs → 401", async () => {
    const res = await request(makeApp()).get("/admin/faqs");
    expect(res.status).toBe(401);
  });

  it("GET /admin/faqs/:id → 401", async () => {
    const res = await request(makeApp()).get("/admin/faqs/1");
    expect(res.status).toBe(401);
  });

  it("POST /admin/faqs → 401", async () => {
    const res = await request(makeApp())
      .post("/admin/faqs")
      .send({ question: "q", answer: "a" });
    expect(res.status).toBe(401);
  });

  it("PUT /admin/faqs/:id → 401", async () => {
    const res = await request(makeApp())
      .put("/admin/faqs/1")
      .send({ question: "q2" });
    expect(res.status).toBe(401);
  });

  it("DELETE /admin/faqs/:id → 401", async () => {
    const res = await request(makeApp()).delete("/admin/faqs/1");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// ロールガード — anonymous role の JWT → 403
// ---------------------------------------------------------------------------
describe("ロール — anonymous → 403", () => {
  it("GET /admin/faqs?tenantId=tenant-a (anonymous role) → 403", async () => {
    const res = await request(makeApp())
      .get("/admin/faqs?tenantId=tenant-a")
      .set("Authorization", bearerOf(ANONYMOUS));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("DELETE /admin/faqs/1?tenantId=tenant-a (anonymous role) → 403", async () => {
    const res = await request(makeApp())
      .delete("/admin/faqs/1?tenantId=tenant-a")
      .set("Authorization", bearerOf(ANONYMOUS));
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// テナント越境 — client_admin が他テナント指定 → 403
// ---------------------------------------------------------------------------
describe("テナント分離 — client_admin 越境 → 403", () => {
  it("GET /admin/faqs?tenantId=tenant-b (JWT は tenant-a) → 403", async () => {
    const res = await request(makeApp())
      .get("/admin/faqs?tenantId=tenant-b")
      .set("Authorization", bearerOf(CLIENT_A));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("GET /admin/faqs/:id?tenantId=tenant-b → 403", async () => {
    const res = await request(makeApp())
      .get("/admin/faqs/1?tenantId=tenant-b")
      .set("Authorization", bearerOf(CLIENT_A));
    expect(res.status).toBe(403);
  });

  it("POST /admin/faqs?tenantId=tenant-b → 403", async () => {
    const res = await request(makeApp())
      .post("/admin/faqs?tenantId=tenant-b")
      .set("Authorization", bearerOf(CLIENT_A))
      .send({ question: "q", answer: "a" });
    expect(res.status).toBe(403);
  });

  it("PUT /admin/faqs/1?tenantId=tenant-b → 403", async () => {
    const res = await request(makeApp())
      .put("/admin/faqs/1?tenantId=tenant-b")
      .set("Authorization", bearerOf(CLIENT_A))
      .send({ question: "q2" });
    expect(res.status).toBe(403);
  });

  it("DELETE /admin/faqs/1?tenantId=tenant-b → 403", async () => {
    const res = await request(makeApp())
      .delete("/admin/faqs/1?tenantId=tenant-b")
      .set("Authorization", bearerOf(CLIENT_A));
    expect(res.status).toBe(403);
  });

  it("x-tenant-id ヘッダーによる越境も 403", async () => {
    const res = await request(makeApp())
      .get("/admin/faqs")
      .set("Authorization", bearerOf(CLIENT_A))
      .set("x-tenant-id", "tenant-b");
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// super_admin previewMode 回帰 — 他テナント指定 → 通過
// ---------------------------------------------------------------------------
describe("super_admin previewMode — 他テナント指定 → 通過", () => {
  it("GET /admin/faqs?tenantId=tenant-b (super_admin) → 200", async () => {
    mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .get("/admin/faqs?tenantId=tenant-b")
      .set("Authorization", bearerOf(SUPER_ADMIN));
    expect(res.status).toBe(200);
  });

  it("DELETE /admin/faqs/1?tenantId=tenant-b (super_admin) → 200", async () => {
    const res = await request(makeApp())
      .delete("/admin/faqs/1?tenantId=tenant-b")
      .set("Authorization", bearerOf(SUPER_ADMIN));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// client_admin 自テナント — tenantId 未指定 → JWT から補完して通過
// ---------------------------------------------------------------------------
describe("client_admin 自テナント — JWT 補完", () => {
  it("GET /admin/faqs (tenantId 未指定) → JWT の tenant-a で DB クエリ", async () => {
    mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .get("/admin/faqs")
      .set("Authorization", bearerOf(CLIENT_A));
    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalled();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE tenant_id = \$1/);
    expect(params[0]).toBe("tenant-a");
  });

  it("GET /admin/faqs?tenantId=tenant-a (自テナント一致) → 200", async () => {
    mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .get("/admin/faqs?tenantId=tenant-a")
      .set("Authorization", bearerOf(CLIENT_A));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// resolveTenantId JWT 優先 (defense-in-depth)
// client_admin の JWT tenant-a が query より優先されること
// ---------------------------------------------------------------------------
describe("resolveTenantId — JWT 優先", () => {
  it("client_admin: query=tenant-a 指定 → JWT の tenant-a で DB クエリ (一致するため通過)", async () => {
    mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .get("/admin/faqs?tenantId=tenant-a")
      .set("Authorization", bearerOf(CLIENT_A));
    expect(res.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe("tenant-a");
  });
});
