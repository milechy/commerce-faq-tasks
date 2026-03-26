// src/api/admin/variants/routes.test.ts
// Phase46: Variant CRUD API テスト

import express from "express";
import request from "supertest";
import { registerVariantRoutes } from "./routes";

// ---------------------------------------------------------------------------
// リポジトリモック
// ---------------------------------------------------------------------------

jest.mock("./variantsRepository", () => ({
  listVariants: jest.fn(),
  upsertVariants: jest.fn(),
  getVariantStats: jest.fn(),
}));

import { listVariants, upsertVariants, getVariantStats } from "./variantsRepository";

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
  registerVariantRoutes(app);
  return app;
}

// ---------------------------------------------------------------------------
// テストデータ
// ---------------------------------------------------------------------------

const VARIANTS = [
  { id: "v1", name: "デフォルト", prompt: "あなたはAIアシスタントです", weight: 60 },
  { id: "v2", name: "積極的", prompt: "あなたは積極的なAIアシスタントです", weight: 40 },
];

const STATS = [
  { id: "v1", name: "デフォルト", weight: 60, avg_score: 75.5, conversation_count: 120 },
  { id: "v2", name: "積極的", weight: 40, avg_score: 80.2, conversation_count: 85 },
];

beforeEach(() => {
  jest.clearAllMocks();
});

// 1. GET /v1/admin/variants → 200
describe("1. GET /v1/admin/variants → 200", () => {
  it("returns variants list", async () => {
    (listVariants as jest.Mock).mockResolvedValue(VARIANTS);

    const res = await request(makeApp()).get("/v1/admin/variants?tenantId=tenant-a");

    expect(res.status).toBe(200);
    expect(res.body.variants).toHaveLength(2);
    expect(res.body.variants[0].id).toBe("v1");
  });
});

// 2. PUT /v1/admin/variants（正常）→ 200
describe("2. PUT /v1/admin/variants（正常）→ 200", () => {
  it("updates variants and returns updated list", async () => {
    (upsertVariants as jest.Mock).mockResolvedValue(VARIANTS);

    const res = await request(makeApp())
      .put("/v1/admin/variants")
      .send({ tenantId: "tenant-a", variants: VARIANTS });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.variants).toHaveLength(2);
  });
});

// 3. PUT /v1/admin/variants（weight合計≠100）→ 400
describe("3. PUT /v1/admin/variants（weight合計≠100）→ 400", () => {
  it("returns 400 when weight total is not 100", async () => {
    const badVariants = [
      { id: "v1", name: "A", prompt: "prompt A", weight: 60 },
      { id: "v2", name: "B", prompt: "prompt B", weight: 30 },
    ];

    const res = await request(makeApp())
      .put("/v1/admin/variants")
      .send({ tenantId: "tenant-a", variants: badVariants });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("バリエーションの比率の合計は100%にしてください");
  });
});

// 4. GET /v1/admin/variants/stats → variant別スコア集計
describe("4. GET /v1/admin/variants/stats → variant別スコア集計", () => {
  it("returns variant stats with avg_score and conversation_count", async () => {
    (getVariantStats as jest.Mock).mockResolvedValue(STATS);

    const res = await request(makeApp()).get("/v1/admin/variants/stats?tenantId=tenant-a&days=30");

    expect(res.status).toBe(200);
    expect(res.body.variants).toHaveLength(2);
    expect(res.body.variants[0].avg_score).toBe(75.5);
    expect(res.body.variants[1].conversation_count).toBe(85);
  });
});

// 5. 認証なし → 401
describe("5. 認証なし → 401", () => {
  it("returns 401 when no auth", async () => {
    const app = express();
    app.use(express.json());
    app.use("/v1/admin/variants", (_req: any, res: any) =>
      res.status(401).json({ error: "Unauthorized" }),
    );

    const res = await request(app).get("/v1/admin/variants");
    expect(res.status).toBe(401);
  });
});

// 6. client_admin 他テナント → 403
describe("6. client_admin 他テナント → 403", () => {
  it("returns 403 when client_admin accesses other tenant", async () => {
    const res = await request(makeApp("client_admin", "tenant-a")).get(
      "/v1/admin/variants?tenantId=tenant-b",
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("他テナントのデータにアクセスできません");
  });
});

// 7. super_admin は他テナント参照可
describe("7. super_admin は他テナント参照可", () => {
  it("allows super_admin to access other tenant", async () => {
    (listVariants as jest.Mock).mockResolvedValue(VARIANTS);

    const res = await request(makeApp("super_admin", "tenant-admin")).get(
      "/v1/admin/variants?tenantId=tenant-b",
    );

    expect(res.status).toBe(200);
    expect((listVariants as jest.Mock).mock.calls[0][0]).toBe("tenant-b");
  });
});
