// tests/phase54/tuningSuggest.test.ts
// POST /v1/admin/tuning/suggest-rule のテスト

import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mock supabaseAuthMiddleware
// ---------------------------------------------------------------------------
jest.mock("../../src/admin/http/supabaseAuthMiddleware", () => ({
  supabaseAuthMiddleware: (_req: any, _res: any, next: any) => next(),
}));

// ---------------------------------------------------------------------------
// Mock fetch (Groq API)
// ---------------------------------------------------------------------------
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

import { registerTuningRoutes } from "../../src/api/admin/tuning/routes";

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function makeApp(role: "super_admin" | "client_admin" | "anonymous" | null = "client_admin") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    if (role !== null) {
      req.supabaseUser = {
        email: "test@example.com",
        app_metadata: { tenant_id: "tenant-a", role },
      };
    }
    next();
  });
  registerTuningRoutes(app);
  return app;
}

function mockGroqSuccess(suggestion: object) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify(suggestion),
          },
        },
      ],
    }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GROQ_API_KEY = "test-key";
});

// ===========================================================================
// 1. 正常系
// ===========================================================================

describe("1. POST /v1/admin/tuning/suggest-rule — 正常系", () => {
  it("Groq 8b の提案をそのまま返す", async () => {
    mockGroqSuccess({
      trigger_pattern: "価格について",
      instruction: "料金プランを丁寧に説明する",
      priority: 7,
      reason: "価格への不安を解消するため",
    });

    const res = await request(makeApp("client_admin"))
      .post("/v1/admin/tuning/suggest-rule")
      .send({
        userMessage: "料金はいくらですか？",
        aiMessage: "詳細はお問い合わせください。",
      });

    expect(res.status).toBe(200);
    expect(res.body.trigger_pattern).toBe("価格について");
    expect(res.body.instruction).toBe("料金プランを丁寧に説明する");
    expect(res.body.priority).toBe(7);
    expect(res.body.reason).toBe("価格への不安を解消するため");
  });

  it("super_admin もアクセス可", async () => {
    mockGroqSuccess({
      trigger_pattern: "返金について",
      instruction: "返金ポリシーを案内する",
      priority: 5,
      reason: "返金に関する問い合わせが多いため",
    });

    const res = await request(makeApp("super_admin"))
      .post("/v1/admin/tuning/suggest-rule")
      .send({
        userMessage: "返金できますか？",
        aiMessage: "返金はできません。",
      });

    expect(res.status).toBe(200);
    expect(res.body.trigger_pattern).toBe("返金について");
  });

  it("Groq がmarkdown code blockで返しても正しくパースする", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: "```json\n" + JSON.stringify({
                trigger_pattern: "営業時間",
                instruction: "営業時間を明確に案内する",
                priority: 3,
                reason: "よくある質問のため",
              }) + "\n```",
            },
          },
        ],
      }),
    });

    const res = await request(makeApp("client_admin"))
      .post("/v1/admin/tuning/suggest-rule")
      .send({ userMessage: "何時まで営業ですか？", aiMessage: "営業中です。" });

    expect(res.status).toBe(200);
    expect(res.body.trigger_pattern).toBe("営業時間");
  });

  it("priority を 0〜10 にクランプする", async () => {
    mockGroqSuccess({
      trigger_pattern: "test",
      instruction: "test instruction",
      priority: 99,
      reason: "test reason",
    });

    const res = await request(makeApp("client_admin"))
      .post("/v1/admin/tuning/suggest-rule")
      .send({ userMessage: "test", aiMessage: "test response" });

    expect(res.status).toBe(200);
    expect(res.body.priority).toBe(10);
  });
});

// ===========================================================================
// 2. 認証エラー
// ===========================================================================

describe("2. 認証エラー", () => {
  it("supabaseUser が null の場合 401", async () => {
    const res = await request(makeApp(null))
      .post("/v1/admin/tuning/suggest-rule")
      .send({ userMessage: "test", aiMessage: "test" });

    expect(res.status).toBe(401);
  });

  it("anonymous ロールは 403", async () => {
    const res = await request(makeApp("anonymous"))
      .post("/v1/admin/tuning/suggest-rule")
      .send({ userMessage: "test", aiMessage: "test" });

    expect(res.status).toBe(403);
  });

  it("バリデーションエラー: userMessage 欠落 → 400", async () => {
    const res = await request(makeApp("client_admin"))
      .post("/v1/admin/tuning/suggest-rule")
      .send({ aiMessage: "test" });

    expect(res.status).toBe(400);
  });

  it("バリデーションエラー: 空文字列 → 400", async () => {
    const res = await request(makeApp("client_admin"))
      .post("/v1/admin/tuning/suggest-rule")
      .send({ userMessage: "   ", aiMessage: "test" });

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// 3. Groq API 失敗 → 空の提案を返す（500にならない）
// ===========================================================================

describe("3. Groq API 失敗 — 空提案フォールバック", () => {
  it("Groq が 500 を返した場合、空提案を返す", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const res = await request(makeApp("client_admin"))
      .post("/v1/admin/tuning/suggest-rule")
      .send({ userMessage: "テスト", aiMessage: "レスポンス" });

    expect(res.status).toBe(200);
    expect(res.body.trigger_pattern).toBe("");
    expect(res.body.instruction).toBe("");
    expect(res.body.priority).toBe(0);
  });

  it("fetch が例外をスローした場合、空提案を返す", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const res = await request(makeApp("client_admin"))
      .post("/v1/admin/tuning/suggest-rule")
      .send({ userMessage: "テスト", aiMessage: "レスポンス" });

    expect(res.status).toBe(200);
    expect(res.body.trigger_pattern).toBe("");
  });

  it("Groq が不正な JSON を返した場合、空提案を返す", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "invalid json" } }] }),
    });

    const res = await request(makeApp("client_admin"))
      .post("/v1/admin/tuning/suggest-rule")
      .send({ userMessage: "テスト", aiMessage: "レスポンス" });

    expect(res.status).toBe(200);
    expect(res.body.trigger_pattern).toBe("");
  });

  it("GROQ_API_KEY 未設定の場合、空提案を返す", async () => {
    delete process.env.GROQ_API_KEY;

    const res = await request(makeApp("client_admin"))
      .post("/v1/admin/tuning/suggest-rule")
      .send({ userMessage: "テスト", aiMessage: "レスポンス" });

    expect(res.status).toBe(200);
    expect(res.body.trigger_pattern).toBe("");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
