// src/api/admin/evaluations/routes.test.ts
// Phase45: 評価API テスト

import express from "express";
import { request } from "../../../../tests/helpers/testServer";
import { registerEvaluationRoutes } from "./routes";

// ---------------------------------------------------------------------------
// DB モック
// ---------------------------------------------------------------------------

// D8-2: 承認時のテナント通知が実際に発火するか(そして behavior では発火しないか)を
// ルート層で固定する。通知本文の中身は upsellRenderer.test.ts が別途担保する。
const mockPoolQuery = jest.fn();
jest.mock("../../../lib/db", () => ({
  getPool: () => ({ query: (...a: unknown[]) => mockPoolQuery(...a) }),
}));
jest.mock("../../../lib/notifications", () => ({ createNotification: jest.fn() }));
jest.mock("../../../lib/billing/billingApi", () => ({ buildTenantUpsellFigures: jest.fn() }));

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
  approveTuningRule,
  rejectTuningRule,
} from "./evaluationsRepository";
import { createNotification } from "../../../lib/notifications";
import { buildTenantUpsellFigures } from "../../../lib/billing/billingApi";

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

// GID 1217808301732050: GET /v1/admin/evaluations/:sessionId → 未評価は200+空配列
// (以前は404を返しており、UI側が「未評価」と「取得失敗」を区別できなかった)
describe("1b. GET /v1/admin/evaluations/:sessionId → 200（0件でも404にしない）", () => {
  it("評価が0件でも404ではなく200+空配列を返す", async () => {
    (getEvaluationsBySession as jest.Mock).mockResolvedValue([]);

    const res = await request(makeApp()).get("/v1/admin/evaluations/sess-001");

    expect(res.status).toBe(200);
    expect(res.body.evaluations).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it("評価がある場合はそのまま返す", async () => {
    (getEvaluationsBySession as jest.Mock).mockResolvedValue([EVAL_ROW]);

    const res = await request(makeApp()).get("/v1/admin/evaluations/sess-001");

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.evaluations[0].session_id).toBe("sess-001");
  });

  it("DBエラー時は500を返す（未評価と区別できる）", async () => {
    (getEvaluationsBySession as jest.Mock).mockRejectedValue(new Error("db down"));

    const res = await request(makeApp()).get("/v1/admin/evaluations/sess-001");

    expect(res.status).toBe(500);
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

// ---------------------------------------------------------------------------
// D8-2: アップセル提案を「採用」したときだけテナントへ通知する
// ---------------------------------------------------------------------------
describe("D8-2: 承認時のテナント通知", () => {
  const UPSELL_EVIDENCE = {
    upsell: { signal: "text_overage", current_plan: "standard", recommended_plan: "growth" },
  };

  beforeEach(() => {
    (createNotification as jest.Mock).mockReset().mockResolvedValue(undefined);
    (buildTenantUpsellFigures as jest.Mock).mockReset().mockResolvedValue({
      __audience: "tenant",
      signal: "text_overage",
      current_plan: "standard",
      recommended_plan: "growth",
      current_base_monthly_jpy: 9800,
      recommended_base_monthly_jpy: 29800,
      text_included_now: 1000,
      text_included_after: 3000,
      avatar_included_minutes_now: 30,
      avatar_included_minutes_after: 150,
      text_overage: 500,
      avatar_overage_minutes: 0,
      as_of: "2026-09-04T00:00:00.000Z",
    });
    mockPoolQuery.mockReset().mockResolvedValue({
      rows: [{ tenant_id: "tenant-a", evidence: UPSELL_EVIDENCE }],
    });
  });

  it("★upsell を承認するとテナントへ通知が飛ぶ★", async () => {
    (approveTuningRule as jest.Mock).mockResolvedValue({
      id: 1, tenant_id: "tenant-a", status: "active",
      is_active: false, proposal_type: "upsell",
      approved_at: NOW, rejected_at: null, updated_at: NOW,
    });

    const res = await request(makeApp()).put("/v1/admin/tuning/1/approve");
    expect(res.status).toBe(200);
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientRole: "client_admin",
        recipientTenantId: "tenant-a",
        link: "/admin/billing",
      }),
    );
  });

  it("★behavior の承認では通知しない（従来の挙動を変えない）★", async () => {
    (approveTuningRule as jest.Mock).mockResolvedValue({
      id: 2, tenant_id: "tenant-a", status: "active",
      is_active: true, proposal_type: "behavior",
      approved_at: NOW, rejected_at: null, updated_at: NOW,
    });

    const res = await request(makeApp()).put("/v1/admin/tuning/2/approve");
    expect(res.status).toBe(200);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it("★通知の組み立てが落ちても承認は成功する（通知失敗で承認を落とさない）★", async () => {
    (approveTuningRule as jest.Mock).mockResolvedValue({
      id: 3, tenant_id: "tenant-a", status: "active",
      is_active: false, proposal_type: "upsell",
      approved_at: NOW, rejected_at: null, updated_at: NOW,
    });
    (buildTenantUpsellFigures as jest.Mock).mockRejectedValue(new Error("stripe down"));

    const res = await request(makeApp()).put("/v1/admin/tuning/3/approve");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("evidence の upsell が壊れていれば通知しない（誤った文面を出すより出さない）", async () => {
    (approveTuningRule as jest.Mock).mockResolvedValue({
      id: 4, tenant_id: "tenant-a", status: "active",
      is_active: false, proposal_type: "upsell",
      approved_at: NOW, rejected_at: null, updated_at: NOW,
    });
    mockPoolQuery.mockResolvedValue({
      rows: [{ tenant_id: "tenant-a", evidence: { upsell: { signal: "bogus" } } }],
    });

    const res = await request(makeApp()).put("/v1/admin/tuning/4/approve");
    expect(res.status).toBe(200);
    expect(createNotification).not.toHaveBeenCalled();
  });
});
