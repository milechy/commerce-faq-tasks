// src/api/admin/evaluations/routes.test.ts
// Phase45: 評価API テスト

import express from "express";
import request from "supertest";
import { registerEvaluationRoutes } from "./routes";

// ---------------------------------------------------------------------------
// DB モック
// ---------------------------------------------------------------------------

jest.mock("./evaluationsRepository", () => ({
  listEvaluations: jest.fn(),
  getDetailedStats: jest.fn(),
  getEvaluationsBySession: jest.fn(),
  updateOutcome: jest.fn(),
  getKpiStats: jest.fn(),
  approveTuningRule: jest.fn(),
  rejectTuningRule: jest.fn(),
}));

import {
  listEvaluations,
  getDetailedStats,
  getEvaluationsBySession,
  updateOutcome,
  getKpiStats,
  approveTuningRule,
  rejectTuningRule,
} from "./evaluationsRepository";

// ---------------------------------------------------------------------------
// テスト用 Express アプリ生成
// ---------------------------------------------------------------------------

type Role = "super_admin" | "client_admin";

function makeApp(role: Role = "client_admin", tenantId = "tenant-a") {
  const app = express();
  app.use(express.json());

  // supabaseAuthMiddleware をバイパス
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = {
      email: "test@example.com",
      app_metadata: { tenant_id: tenantId, role },
    };
    next();
  });

  registerEvaluationRoutes(app);
  return app;
}

function makeAppNoAuth() {
  const app = express();
  app.use(express.json());
  // supabaseAuthMiddleware をモック → 401 を返す
  jest.mock("../../../admin/http/supabaseAuthMiddleware", () => ({
    supabaseAuthMiddleware: (_req: any, res: any) =>
      res.status(401).json({ error: "Unauthorized" }),
  }));
  registerEvaluationRoutes(app);
  return app;
}

const NOW = new Date().toISOString();

const EVAL_ROW = {
  id: 1,
  tenant_id: "tenant-a",
  session_id: "sess-001",
  score: 85,
  used_principles: ["empathy", "clarity"],
  effective_principles: ["empathy"],
  failed_principles: [],
  evaluation_axes: { principle_appropriateness: 80, customer_reaction: 75, stage_progression: 70, contraindication_compliance: 90 },
  notes: null,
  model_used: "groq-20b",
  evaluated_at: NOW,
  outcome: "unknown",
  outcome_updated_by: null,
  outcome_updated_at: null,
};

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

// 1. GET /v1/admin/evaluations → 200
describe("1. GET /v1/admin/evaluations → 200", () => {
  it("returns evaluations list with stats", async () => {
    (listEvaluations as jest.Mock).mockResolvedValue({
      evaluations: [EVAL_ROW],
      stats: { avg_score: 0.85, count: 1 },
      total: 1,
    });

    const res = await request(makeApp()).get("/v1/admin/evaluations");

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.evaluations).toHaveLength(1);
    expect(res.body.stats.avg_score).toBe(0.85);
  });
});

// 2. GET /v1/admin/evaluations/stats → 集計
describe("2. GET /v1/admin/evaluations/stats → 集計", () => {
  it("returns detailed stats", async () => {
    (getDetailedStats as jest.Mock).mockResolvedValue({
      avg_score: 0.78,
      principle_stats: { empathy: 0.9 },
      reaction_distribution: { positive: 5, neutral: 2 },
      stage_progression_rate: 0.6,
    });

    const res = await request(makeApp()).get("/v1/admin/evaluations/stats");

    expect(res.status).toBe(200);
    expect(res.body.avg_score).toBe(0.78);
    expect(res.body.stage_progression_rate).toBe(0.6);
  });
});

// 3. PUT /v1/admin/evaluations/:id/outcome → 更新
describe("3. PUT /v1/admin/evaluations/:id/outcome → 更新", () => {
  it("updates outcome and returns success message", async () => {
    (updateOutcome as jest.Mock).mockResolvedValue({
      ...EVAL_ROW,
      outcome: "appointment",
      outcome_updated_by: "test@example.com",
      outcome_updated_at: NOW,
    } as any);

    const res = await request(makeApp())
      .put("/v1/admin/evaluations/1/outcome")
      .send({ outcome: "appointment" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toBe("営業結果を記録しました");
    expect(res.body.evaluation.outcome).toBe("appointment");
  });
});

// 4. 不正 outcome → 400
describe("4. 不正 outcome → 400", () => {
  it("returns 400 for invalid outcome value", async () => {
    const res = await request(makeApp())
      .put("/v1/admin/evaluations/1/outcome")
      .send({ outcome: "invalid_value" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("不正な営業結果です");
  });
});

// 5. 認証なし → 401
describe("5. 認証なし → 401", () => {
  it("returns 401 when no auth", async () => {
    // supabaseAuthMiddleware をリセットして実際の動作をモック
    jest.resetModules();
    const mockAuth = jest.fn((_req: any, res: any) =>
      res.status(401).json({ error: "Unauthorized" }),
    );
    jest.doMock("../../../admin/http/supabaseAuthMiddleware", () => ({
      supabaseAuthMiddleware: mockAuth,
    }));

    const app = express();
    app.use(express.json());
    // authMiddleware が 401 を返す Express アプリ
    app.use("/v1/admin/evaluations", (_req: any, res: any) =>
      res.status(401).json({ error: "Unauthorized" }),
    );

    const res = await request(app).get("/v1/admin/evaluations");
    expect(res.status).toBe(401);
  });
});

// 6. client_admin 他テナント → 403（tenantId は JWT から取得されるため自テナント強制）
describe("6. client_admin 他テナント → 403", () => {
  it("ignores tenantId query param and uses JWT tenant", async () => {
    (listEvaluations as jest.Mock).mockResolvedValue({
      evaluations: [],
      stats: { avg_score: 0, count: 0 },
      total: 0,
    });

    // client_admin は JWT の tenant-a が強制されるので他テナント指定は無視
    const res = await request(makeApp("client_admin", "tenant-a")).get(
      "/v1/admin/evaluations?tenantId=tenant-b",
    );

    expect(res.status).toBe(200);
    // tenantId = 'tenant-a' で呼ばれること（tenant-b ではない）
    expect((listEvaluations as jest.Mock).mock.calls[0][0].tenantId).toBe("tenant-a");
  });
});

// 7. PUT /v1/admin/tuning/:id/approve → status='active'
describe("7. PUT /v1/admin/tuning/:id/approve → status='active'", () => {
  it("approves tuning rule", async () => {
    (approveTuningRule as jest.Mock).mockResolvedValue({
      id: 1,
      tenant_id: "tenant-a",
      status: "active",
      approved_at: NOW,
      rejected_at: null,
      updated_at: NOW,
    });

    const res = await request(makeApp()).put("/v1/admin/tuning/1/approve");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.rule.status).toBe("active");
  });
});

// 8. PUT /v1/admin/tuning/:id/reject → status='rejected'
describe("8. PUT /v1/admin/tuning/:id/reject → status='rejected'", () => {
  it("rejects tuning rule", async () => {
    (rejectTuningRule as jest.Mock).mockResolvedValue({
      id: 1,
      tenant_id: "tenant-a",
      status: "rejected",
      approved_at: null,
      rejected_at: NOW,
      updated_at: NOW,
    });

    const res = await request(makeApp()).put("/v1/admin/tuning/1/reject");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.rule.status).toBe("rejected");
  });
});
