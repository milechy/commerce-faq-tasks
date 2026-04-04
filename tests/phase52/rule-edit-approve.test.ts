// tests/phase52/rule-edit-approve.test.ts
// Phase52c: AI提案ルール承認前編集機能のテスト

import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mock evaluationsRepository
// ---------------------------------------------------------------------------

const mockInsertTuningRuleFromSuggestion = jest.fn();
const mockUpdateSuggestedRuleStatus = jest.fn();
const mockGetEvaluationById = jest.fn();

jest.mock("../../src/api/admin/evaluations/evaluationsRepository", () => ({
  listEvaluations: jest.fn(),
  getDetailedStats: jest.fn(),
  getEvaluationsBySession: jest.fn(),
  updateOutcome: jest.fn(),
  getKpiStats: jest.fn(),
  approveTuningRule: jest.fn(),
  rejectTuningRule: jest.fn(),
  getEvaluationById: (...args: any[]) => mockGetEvaluationById(...args),
  checkAlreadyEvaluated: jest.fn(),
  updateSuggestedRuleStatus: (...args: any[]) => mockUpdateSuggestedRuleStatus(...args),
  insertTuningRuleFromSuggestion: (...args: any[]) => mockInsertTuningRuleFromSuggestion(...args),
}));

jest.mock("../../src/admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));

import { registerEvaluationRoutes } from "../../src/api/admin/evaluations/routes";

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function makeApp(role: "super_admin" | "client_admin" | "anonymous" = "super_admin", tenantId = "tenant-a") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = {
      email: "admin@example.com",
      app_metadata: { tenant_id: tenantId, role },
    };
    next();
  });
  registerEvaluationRoutes(app);
  return app;
}

const EVAL_DATA = {
  evaluation: {
    id: 1,
    tenant_id: "tenant-a",
    session_id: "sess-1",
    score: 45,
    suggested_rules: [
      { rule_text: "AI原文ルール", reason: "スコアが低い", priority: "high" },
    ],
    evaluated_at: new Date().toISOString(),
  },
  messages: [],
};

const UPDATED_EVAL = {
  id: 1,
  tenant_id: "tenant-a",
  session_id: "sess-1",
  score: 45,
  suggested_rules: [
    { rule_text: "AI原文ルール", reason: "スコアが低い", priority: "high", status: "approved" },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetEvaluationById.mockResolvedValue(EVAL_DATA);
  mockUpdateSuggestedRuleStatus.mockResolvedValue(UPDATED_EVAL);
  mockInsertTuningRuleFromSuggestion.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// 1. 承認（edited_textなし）— AI原文をそのまま保存
// ---------------------------------------------------------------------------
describe("1. 承認（edited_textなし）— AI原文をそのまま保存", () => {
  it("insertTuningRuleFromSuggestion をオプションなしで呼ぶ", async () => {
    const res = await request(makeApp())
      .patch("/v1/admin/evaluations/1/rules/0")
      .send({ action: "approve" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    expect(mockInsertTuningRuleFromSuggestion).toHaveBeenCalledWith(
      "tenant-a",
      "AI原文ルール",
      { editedText: undefined, editedBy: "admin@example.com" },
    );
    expect(mockUpdateSuggestedRuleStatus).toHaveBeenCalledWith(1, 0, "approved", undefined);
  });
});

// ---------------------------------------------------------------------------
// 2. 承認（edited_textあり）— 編集後テキストを保存
// ---------------------------------------------------------------------------
describe("2. 承認（edited_textあり）— 編集後テキストを保存", () => {
  it("insertTuningRuleFromSuggestion を edited_text 付きで呼ぶ", async () => {
    const res = await request(makeApp())
      .patch("/v1/admin/evaluations/1/rules/0")
      .send({ action: "approve", edited_text: "編集後のルールテキスト" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    expect(mockInsertTuningRuleFromSuggestion).toHaveBeenCalledWith(
      "tenant-a",
      "AI原文ルール",
      { editedText: "編集後のルールテキスト", editedBy: "admin@example.com" },
    );
  });
});

// ---------------------------------------------------------------------------
// 3. 却下 — edited_text 無視、insertTuningRuleFromSuggestion 未呼出
// ---------------------------------------------------------------------------
describe("3. 却下 — insertTuningRuleFromSuggestion を呼ばない", () => {
  it("reject では insert を呼ばない", async () => {
    const res = await request(makeApp())
      .patch("/v1/admin/evaluations/1/rules/0")
      .send({ action: "reject" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockInsertTuningRuleFromSuggestion).not.toHaveBeenCalled();
    expect(mockUpdateSuggestedRuleStatus).toHaveBeenCalledWith(1, 0, "rejected", undefined);
  });
});

// ---------------------------------------------------------------------------
// 4. バリデーション — edited_text が空文字列
// ---------------------------------------------------------------------------
describe("4. バリデーション — edited_text が空文字列 → 400", () => {
  it("空の edited_text は拒否される", async () => {
    const res = await request(makeApp())
      .patch("/v1/admin/evaluations/1/rules/0")
      .send({ action: "approve", edited_text: "  " });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/edited_text/);
  });
});

// ---------------------------------------------------------------------------
// 5. 未認証 — super_admin 以外は403
// ---------------------------------------------------------------------------
describe("5. anonymous → 403", () => {
  it("anonymous ユーザーはアクセス不可", async () => {
    const res = await request(makeApp("anonymous"))
      .patch("/v1/admin/evaluations/1/rules/0")
      .send({ action: "approve" });

    expect(res.status).toBe(403);
  });
});
