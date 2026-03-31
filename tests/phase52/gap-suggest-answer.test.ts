// tests/phase52/gap-suggest-answer.test.ts
// Phase52d: ナレッジの穴 AI回答案自動生成エンドポイントのテスト

import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();

jest.mock("../../src/lib/db", () => ({
  getPool: () => ({ query: (...args: any[]) => mockQuery(...args) }),
}));

const mockCallGeminiJudge = jest.fn();

jest.mock("../../src/lib/gemini/client", () => ({
  callGeminiJudge: (...args: any[]) => mockCallGeminiJudge(...args),
}));

jest.mock("../../src/agent/llm/openaiEmbeddingClient", () => ({
  embedText: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

jest.mock("../../src/agent/gap/gapRecommender", () => ({
  generateRecommendations: jest.fn().mockResolvedValue([]),
}));

jest.mock("../../src/admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));

import { registerKnowledgeGapPhase46Routes } from "../../src/api/admin/knowledge-gaps/routes";

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

type Role = "super_admin" | "client_admin" | "viewer";

function makeApp(role: Role = "super_admin", tenantId = "tenant-a") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.supabaseUser = {
      email: "admin@example.com",
      app_metadata: { tenant_id: tenantId, role },
    };
    next();
  });
  registerKnowledgeGapPhase46Routes(app);
  return app;
}

function makeUnauthApp() {
  const app = express();
  app.use(express.json());
  // no supabaseUser → resolveJwt returns empty, no admin role
  registerKnowledgeGapPhase46Routes(app);
  return app;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const GAP_ROW = {
  id: 1,
  tenant_id: "tenant-a",
  user_question: "電気自動車のバッテリー交換費用は？",
  frequency: 5,
};

const TENANT_ROW = {
  system_prompt: "BtoB EV販売の営業AIです。",
};

const FAQ_ROWS = [
  { question: "バッテリー保証について", answer: "5年間の保証が付きます。" },
  { question: "EV車種一覧", answer: "Model A、Model Bをご用意しております。" },
];

// ---------------------------------------------------------------------------
// 1. 正常系
// ---------------------------------------------------------------------------
describe("1. 正常系 — suggested_answer が返る", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery
      .mockResolvedValueOnce({ rows: [GAP_ROW] })       // knowledge_gaps
      .mockResolvedValueOnce({ rows: [TENANT_ROW] })    // tenants
      .mockResolvedValueOnce({ rows: FAQ_ROWS });        // faq_docs
    mockCallGeminiJudge.mockResolvedValue("バッテリー交換は保証期間外で約30万円です。詳しくはお問い合わせください。");
  });

  it("200 + suggested_answer + sources を返す", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/knowledge-gaps/1/suggest-answer");

    expect(res.status).toBe(200);
    expect(res.body.suggested_answer).toContain("バッテリー");
    expect(res.body.question).toBe("電気自動車のバッテリー交換費用は？");
    expect(res.body.sources).toEqual(["バッテリー保証について", "EV車種一覧"]);
  });

  it("Gemini にシステムプロンプトと質問が渡される", async () => {
    await request(makeApp()).post("/v1/admin/knowledge-gaps/1/suggest-answer");

    expect(mockCallGeminiJudge).toHaveBeenCalledTimes(1);
    const prompt = mockCallGeminiJudge.mock.calls[0][0] as string;
    expect(prompt).toContain("電気自動車のバッテリー交換費用は？");
    expect(prompt).toContain("BtoB EV販売");
    expect(prompt).toContain("バッテリー保証について");
  });
});

// ---------------------------------------------------------------------------
// 2. knowledge_gap 未存在 → 404
// ---------------------------------------------------------------------------
describe("2. knowledge_gap 未存在 → 404", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValueOnce({ rows: [] });
  });

  it("returns 404", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/knowledge-gaps/999/suggest-answer");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/ギャップが見つかりません/);
  });
});

// ---------------------------------------------------------------------------
// 3. client_admin 他テナント → 403
// ---------------------------------------------------------------------------
describe("3. client_admin 他テナントのギャップ → 403", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValueOnce({ rows: [{ ...GAP_ROW, tenant_id: "tenant-b" }] });
  });

  it("returns 403", async () => {
    const res = await request(makeApp("client_admin", "tenant-a"))
      .post("/v1/admin/knowledge-gaps/1/suggest-answer");

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 4. 未認証（role なし） → 403
// ---------------------------------------------------------------------------
describe("4. 未認証（role なし） → 403", () => {
  it("returns 403", async () => {
    const res = await request(makeUnauthApp())
      .post("/v1/admin/knowledge-gaps/1/suggest-answer");

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 5. Gemini API エラー → 500
// ---------------------------------------------------------------------------
describe("5. Gemini API エラー → 500", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery
      .mockResolvedValueOnce({ rows: [GAP_ROW] })
      .mockResolvedValueOnce({ rows: [TENANT_ROW] })
      .mockResolvedValueOnce({ rows: [] });
    mockCallGeminiJudge.mockRejectedValue(new Error("Gemini API error: 503"));
  });

  it("returns 500 with error message", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/knowledge-gaps/1/suggest-answer");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/AI回答案の生成に失敗/);
  });
});
