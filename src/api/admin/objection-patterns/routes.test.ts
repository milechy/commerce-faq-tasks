// src/api/admin/objection-patterns/routes.test.ts
// Phase46: 反論パターン API テスト

import express from "express";
import request from "supertest";
import { registerObjectionPatternRoutes } from "./routes";

// ---------------------------------------------------------------------------
// リポジトリモック
// ---------------------------------------------------------------------------

jest.mock("./objectionPatternsRepository", () => ({
  listObjectionPatterns: jest.fn(),
  getObjectionPattern: jest.fn(),
  deleteObjectionPattern: jest.fn(),
}));

import {
  listObjectionPatterns,
  getObjectionPattern,
  deleteObjectionPattern,
} from "./objectionPatternsRepository";

// ---------------------------------------------------------------------------
// テスト用 Express アプリ生成
// ---------------------------------------------------------------------------

type Role = "super_admin" | "client_admin";

function makeApp(role: Role = "client_admin", tenantId = "tenant-a") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = {
      email: "test@example.com",
      app_metadata: { tenant_id: tenantId, role },
    };
    next();
  });
  registerObjectionPatternRoutes(app);
  return app;
}

// ---------------------------------------------------------------------------
// テストデータ
// ---------------------------------------------------------------------------

const NOW = new Date().toISOString();

const PATTERN = {
  id: 1,
  tenant_id: "tenant-a",
  pattern: "価格が高すぎる",
  response_template: "費用対効果をご説明します",
  success_rate: 72.5,
  occurrence_count: 45,
  created_at: NOW,
  updated_at: NOW,
};

beforeEach(() => {
  jest.clearAllMocks();
});

// 1. GET /v1/admin/objection-patterns → 200
describe("1. GET /v1/admin/objection-patterns → 200", () => {
  it("returns patterns list ordered by success_rate", async () => {
    (listObjectionPatterns as jest.Mock).mockResolvedValue([PATTERN]);

    const res = await request(makeApp()).get("/v1/admin/objection-patterns?tenantId=tenant-a");

    expect(res.status).toBe(200);
    expect(res.body.patterns).toHaveLength(1);
    expect(res.body.patterns[0].success_rate).toBe(72.5);
  });
});

// 2. GET /v1/admin/objection-patterns/:id → 200
describe("2. GET /v1/admin/objection-patterns/:id → 200", () => {
  it("returns pattern detail", async () => {
    (getObjectionPattern as jest.Mock).mockResolvedValue(PATTERN);

    const res = await request(makeApp()).get("/v1/admin/objection-patterns/1");

    expect(res.status).toBe(200);
    expect(res.body.pattern.id).toBe(1);
    expect(res.body.pattern.pattern).toBe("価格が高すぎる");
  });
});

// 3. GET /v1/admin/objection-patterns/:id 存在しない → 404
describe("3. GET /v1/admin/objection-patterns/:id 存在しない → 404", () => {
  it("returns 404 when pattern not found", async () => {
    (getObjectionPattern as jest.Mock).mockResolvedValue(null);

    const res = await request(makeApp()).get("/v1/admin/objection-patterns/999");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("パターンが見つかりません");
  });
});

// 4. DELETE /v1/admin/objection-patterns/:id → 200
describe("4. DELETE /v1/admin/objection-patterns/:id → 200", () => {
  it("deletes pattern and returns ok", async () => {
    (deleteObjectionPattern as jest.Mock).mockResolvedValue(true);

    const res = await request(makeApp()).delete("/v1/admin/objection-patterns/1");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// 5. DELETE /v1/admin/objection-patterns/:id 存在しない → 404
describe("5. DELETE /v1/admin/objection-patterns/:id 存在しない → 404", () => {
  it("returns 404 when pattern not found", async () => {
    (deleteObjectionPattern as jest.Mock).mockResolvedValue(false);

    const res = await request(makeApp()).delete("/v1/admin/objection-patterns/999");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("パターンが見つかりません");
  });
});

// 6. 認証なし → 401
describe("6. 認証なし → 401", () => {
  it("returns 401 when no auth", async () => {
    const app = express();
    app.use(express.json());
    app.use("/v1/admin/objection-patterns", (_req: any, res: any) =>
      res.status(401).json({ error: "Unauthorized" }),
    );

    const res = await request(app).get("/v1/admin/objection-patterns");
    expect(res.status).toBe(401);
  });
});

// 7. client_admin 他テナント → 403
describe("7. client_admin 他テナント → 403", () => {
  it("returns 403 when client_admin accesses other tenant", async () => {
    const res = await request(makeApp("client_admin", "tenant-a")).get(
      "/v1/admin/objection-patterns?tenantId=tenant-b",
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("他テナントのデータにアクセスできません");
  });
});
