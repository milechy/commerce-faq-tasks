// src/agent/dialog/dialogAgent.test.ts
// Phase73: productCard が recommend ステージで設定されること / clarify では設定されないことをテスト

// 外部依存（DB/Groq/ES等）をすべて no-op mock にする
jest.mock("../../lib/db", () => ({
  pool: {
    query: jest.fn(),
  },
  getPool: jest.fn(() => ({
    query: jest.fn(),
  })),
}));

jest.mock("../flow/dialogOrchestrator", () => ({
  runDialogOrchestrator: jest.fn(),
}));

jest.mock("../flow/multiStepPlanner", () => ({
  planMultiStepQuery: jest.fn(),
}));

jest.mock("../flow/llmMultiStepPlannerRuntime", () => ({
  planMultiStepQueryWithLlmAsync: jest.fn(),
}));

jest.mock("../orchestrator/sales/runSalesFlowWithLogging", () => ({
  runSalesFlowWithLogging: jest.fn(),
}));

jest.mock("../orchestrator/sales/salesIntentDetector", () => ({
  detectSalesIntents: jest.fn(),
}));

jest.mock("./contextStore", () => ({
  getSessionHistory: jest.fn(() => []),
  appendToSessionHistory: jest.fn(),
}));

jest.mock("./salesContextStore", () => ({
  getSalesSessionMeta: jest.fn(() => null),
  updateSalesSessionMeta: jest.fn(),
}));

import { runDialogTurn } from "./dialogAgent";
import { runDialogOrchestrator } from "../flow/dialogOrchestrator";
import { planMultiStepQuery } from "../flow/multiStepPlanner";
import { runSalesFlowWithLogging } from "../orchestrator/sales/runSalesFlowWithLogging";
import { detectSalesIntents } from "../orchestrator/sales/salesIntentDetector";
import { pool } from "../../lib/db";

const mockOrchestrator = runDialogOrchestrator as jest.MockedFunction<typeof runDialogOrchestrator>;
const mockPlanner = planMultiStepQuery as jest.MockedFunction<typeof planMultiStepQuery>;
const mockSalesFlow = runSalesFlowWithLogging as jest.MockedFunction<typeof runSalesFlowWithLogging>;
const mockDetectIntents = detectSalesIntents as jest.MockedFunction<typeof detectSalesIntents>;
const mockPool = pool as { query: jest.Mock };

/** ベースとなる planner plan の戻り値 */
const basePlan = {
  steps: [],
  needsClarification: false,
  confidence: "high" as const,
};

/** ベースとなる orchestrator の戻り値 */
const baseOrchestrated = {
  answer: "テスト回答",
  steps: [],
  final: true,
  needsClarification: false,
  clarifyingQuestions: undefined,
  gapSignal: undefined,
  llmUsage: { prompt_tokens: 0, completion_tokens: 0 },
  ragSources: undefined,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPlanner.mockResolvedValue(basePlan);
  mockDetectIntents.mockReturnValue({
    proposeIntent: "trial_lesson_offer",
    recommendIntent: "recommend_course_based_on_level",
    closeIntent: undefined,
  });
  mockOrchestrator.mockResolvedValue(baseOrchestrated);
});

describe("runDialogTurn — Phase73 productCard", () => {
  it("recommend ステージで faq_docs に商品メタがある場合 productCard が設定される", async () => {
    // salesFlow が recommend を返す
    mockSalesFlow.mockResolvedValue({
      nextStage: "recommend",
      prompt: "おすすめの商品はこちらです。",
      meta: {} as any,
    });

    // pool.query が商品メタ行を返す
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 42,
          question: "テスト商品の特徴は？",
          product_image_url: "https://example.com/img.jpg",
          product_price: "9800",
          product_cta_url: "https://example.com/product",
        },
      ],
    });

    const result = await runDialogTurn({
      sessionId: "test-session-1",
      tenantId: "test-tenant",
      message: "おすすめを教えて",
    });

    expect(result.productCard).toBeDefined();
    expect(result.productCard?.product_id).toBe("42");
    expect(result.productCard?.price).toBe("9800");
    expect(result.productCard?.image_url).toBe("https://example.com/img.jpg");
    expect(result.productCard?.cta_url).toBe("https://example.com/product");
  });

  it("recommend ステージでも faq_docs に商品メタがない場合 productCard は undefined", async () => {
    mockSalesFlow.mockResolvedValue({
      nextStage: "recommend",
      prompt: "おすすめ商品",
      meta: {} as any,
    });

    // pool.query が空行を返す
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const result = await runDialogTurn({
      sessionId: "test-session-2",
      tenantId: "test-tenant",
      message: "おすすめを教えて",
    });

    expect(result.productCard).toBeUndefined();
  });

  it("clarify ステージでは productCard は設定されない", async () => {
    // salesFlow が nextStage を返さない（clarify 初回）
    mockSalesFlow.mockResolvedValue({
      nextStage: undefined,
      prompt: undefined,
      meta: {} as any,
    });

    const result = await runDialogTurn({
      sessionId: "test-session-3",
      tenantId: "test-tenant",
      message: "価格を教えて",
    });

    expect(result.productCard).toBeUndefined();
    // recommend でないため pool.query が呼ばれないことを確認
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it("pool.query が例外を投げても productCard なしで正常応答する", async () => {
    mockSalesFlow.mockResolvedValue({
      nextStage: "recommend",
      prompt: "おすすめ",
      meta: {} as any,
    });

    // DB 未適用環境を想定（migration 未実行 = column not found エラー）
    mockPool.query.mockRejectedValueOnce(new Error('column "product_image_url" does not exist'));

    const result = await runDialogTurn({
      sessionId: "test-session-4",
      tenantId: "test-tenant",
      message: "おすすめを教えて",
    });

    // エラーは握りつぶされ productCard なしで応答
    expect(result.productCard).toBeUndefined();
    expect(result.answer).toBe("おすすめ"); // salesFlow.prompt が適用される
  });
});
