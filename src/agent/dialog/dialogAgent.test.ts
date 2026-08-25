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
import { getSessionHistory, appendToSessionHistory } from "./contextStore";
import { getSalesSessionMeta, updateSalesSessionMeta } from "./salesContextStore";

const mockOrchestrator = runDialogOrchestrator as jest.MockedFunction<typeof runDialogOrchestrator>;
const mockPlanner = planMultiStepQuery as jest.MockedFunction<typeof planMultiStepQuery>;
const mockSalesFlow = runSalesFlowWithLogging as jest.MockedFunction<typeof runSalesFlowWithLogging>;
const mockDetectIntents = detectSalesIntents as jest.MockedFunction<typeof detectSalesIntents>;
const mockPool = pool as unknown as { query: jest.Mock };

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
  category: undefined,
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
  // PR-11: isSalesStageContinuityEnabled が毎ターン最初に呼ぶ features フラグ
  // 読み取りクエリのデフォルト応答(フラグOFF)。個別テストが recommend の
  // 商品メタクエリを検証する場合は、このデフォルトの後に自分の
  // mockResolvedValueOnce を積む(呼び出し順: フラグ読み取り→商品メタ)。
  mockPool.query.mockResolvedValue({ rows: [{ enabled: null }] });
});

describe("runDialogTurn — Phase73 productCard", () => {
  it("recommend ステージで faq_docs に商品メタがある場合 productCard が設定される", async () => {
    // salesFlow が recommend を返す
    mockSalesFlow.mockResolvedValue({
      nextStage: "recommend",
      prompt: "おすすめの商品はこちらです。",
      meta: {} as any,
    });

    // 1本目: フラグ読み取り(OFF) / 2本目: 商品メタ行
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ enabled: null }] })
      .mockResolvedValueOnce({
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

    // 1本目: フラグ読み取り(OFF) / 2本目: 商品メタ行(空)
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ enabled: null }] })
      .mockResolvedValueOnce({ rows: [] });

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
    // recommend でないため商品メタクエリは呼ばれない。呼ばれるのは
    // PR-11 のフラグ読み取り(isSalesStageContinuityEnabled)の1回のみ。
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it("pool.query が例外を投げても productCard なしで正常応答する", async () => {
    mockSalesFlow.mockResolvedValue({
      nextStage: "recommend",
      prompt: "おすすめ",
      meta: {} as any,
    });

    // 1本目: フラグ読み取り(OFF) / 2本目: DB 未適用環境を想定（migration 未実行 = column not found エラー）
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ enabled: null }] })
      .mockRejectedValueOnce(new Error('column "product_image_url" does not exist'));

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

describe("runDialogTurn — LemonSliceペルソナスワップ ragCategory", () => {
  it("orchestrator の category が meta.ragCategory にそのまま転送される", async () => {
    mockOrchestrator.mockResolvedValue({ ...baseOrchestrated, category: "fashion" });
    mockSalesFlow.mockResolvedValue({
      nextStage: undefined,
      prompt: undefined,
      meta: {} as any,
    });

    const result = await runDialogTurn({
      sessionId: "test-session-category",
      tenantId: "test-tenant",
      message: "このジャケットに合うスカートは？",
    });

    expect(result.meta?.ragCategory).toBe("fashion");
  });

  // PR-2(2026-08-25収益監査): クエリ埋め込みのトークン消費は llmUsage(chatモデル
  // レート)に合算せず、meta.embeddingUsage として別途 chat/route.ts に渡す。
  it("orchestrator の embeddingUsage が meta.embeddingUsage にそのまま転送される", async () => {
    mockOrchestrator.mockResolvedValue({
      ...baseOrchestrated,
      embeddingUsage: { model: "text-embedding-3-small", totalTokens: 12 },
    });
    mockSalesFlow.mockResolvedValue({
      nextStage: undefined,
      prompt: undefined,
      meta: {} as any,
    });

    const result = await runDialogTurn({
      sessionId: "test-session-embedding-usage",
      tenantId: "test-tenant",
      message: "送料について",
    });

    expect(result.meta?.embeddingUsage).toEqual({ model: "text-embedding-3-small", totalTokens: 12 });
  });

  it("orchestrator が embeddingUsage を返さない場合 meta.embeddingUsage は undefined", async () => {
    mockSalesFlow.mockResolvedValue({
      nextStage: undefined,
      prompt: undefined,
      meta: {} as any,
    });

    const result = await runDialogTurn({
      sessionId: "test-session-no-embedding-usage",
      tenantId: "test-tenant",
      message: "こんにちは",
    });

    expect(result.meta?.embeddingUsage).toBeUndefined();
  });

  it("orchestrator が category を返さない場合 meta.ragCategory は undefined", async () => {
    mockSalesFlow.mockResolvedValue({
      nextStage: undefined,
      prompt: undefined,
      meta: {} as any,
    });

    const result = await runDialogTurn({
      sessionId: "test-session-no-category",
      tenantId: "test-tenant",
      message: "こんにちは",
    });

    expect(result.meta?.ragCategory).toBeUndefined();
  });
});

describe("runDialogTurn — PR-11: SalesFlow 段階の引き継ぎ(tenants.features.sales_stage_continuity)", () => {
  const mockGetSalesSessionMeta = getSalesSessionMeta as jest.MockedFunction<typeof getSalesSessionMeta>;
  const mockUpdateSalesSessionMeta = updateSalesSessionMeta as jest.MockedFunction<typeof updateSalesSessionMeta>;

  beforeEach(() => {
    mockGetSalesSessionMeta.mockReset();
    mockUpdateSalesSessionMeta.mockReset();
  });

  // CLAUDE.md テスト章 G-j: フラグOFFのテナントで従来挙動(clarify固定)が
  // 変わらないことを固定する。
  it("フラグOFF(既定)のときは salesContextStore に前ターンの段階があっても previousMeta は undefined のまま(従来挙動を変えない)", async () => {
    // beforeEach の既定モック({enabled: null})により、フラグはOFF扱いになる
    mockGetSalesSessionMeta.mockReturnValue({
      currentStage: "propose",
      proposeTriggered: true,
      lastUpdatedAt: "2026-08-01T00:00:00.000Z",
    });
    mockSalesFlow.mockResolvedValue({
      nextStage: undefined,
      prompt: undefined,
      meta: {} as any,
    });

    await runDialogTurn({
      sessionId: "test-session-flagoff",
      tenantId: "test-tenant",
      message: "こんにちは",
    });

    expect(mockGetSalesSessionMeta).not.toHaveBeenCalled();
    const callArgs = mockSalesFlow.mock.calls[0]![2] as any;
    expect((callArgs as any).previousMeta).toBeUndefined();
  });

  it("フラグONのときは salesContextStore の前ターン段階を previousMeta.phase として渡す", async () => {
    mockPool.query.mockReset().mockResolvedValueOnce({ rows: [{ enabled: "true" }] });
    mockGetSalesSessionMeta.mockReturnValue({
      currentStage: "propose",
      proposeTriggered: true,
      recommendTriggered: false,
      closeTriggered: false,
      personaTags: ["beginner"],
      lastUpdatedAt: "2026-08-01T00:00:00.000Z",
    });
    mockSalesFlow.mockResolvedValue({
      nextStage: "recommend",
      prompt: "おすすめです",
      meta: {} as any,
    });
    // recommend ステージのため商品メタクエリも発生する(空でよい)
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    await runDialogTurn({
      sessionId: "test-session-flagon",
      tenantId: "test-tenant-flagon",
      message: "続きをお願いします",
    });

    expect(mockGetSalesSessionMeta).toHaveBeenCalledWith({
      tenantId: "test-tenant-flagon",
      sessionId: "test-session-flagon",
    });
    const callArgs = mockSalesFlow.mock.calls[0]![2] as any;
    expect((callArgs as any).previousMeta).toEqual(
      expect.objectContaining({
        phase: "propose",
        proposeTriggered: true,
        recommendTriggered: false,
        closeTriggered: false,
        personaTags: ["beginner"],
      }),
    );
  });

  it("salesResult.meta の *Triggered フラグを updateSalesSessionMeta に保存する(次ターンの一度だけトリガー判定に必要)", async () => {
    mockSalesFlow.mockResolvedValue({
      nextStage: "propose",
      prompt: "ご提案です",
      meta: {
        proposeTriggered: true,
        recommendTriggered: false,
        closeTriggered: false,
      } as any,
    });

    await runDialogTurn({
      sessionId: "test-session-persist",
      tenantId: "test-tenant",
      message: "体験レッスンについて教えて",
    });

    expect(mockUpdateSalesSessionMeta).toHaveBeenCalledWith(
      { tenantId: "test-tenant", sessionId: "test-session-persist" },
      expect.objectContaining({
        currentStage: "propose",
        proposeTriggered: true,
        recommendTriggered: false,
        closeTriggered: false,
      }),
    );
  });
});

describe("runDialogTurn — tenantId の contextStore への伝播", () => {
  const mockGetHistory = getSessionHistory as jest.MockedFunction<typeof getSessionHistory>;
  const mockAppendHistory = appendToSessionHistory as jest.MockedFunction<typeof appendToSessionHistory>;

  beforeEach(() => {
    mockSalesFlow.mockResolvedValue({
      nextStage: undefined,
      prompt: undefined,
      meta: {} as any,
    });
  });

  it("tenantId を指定した場合、getSessionHistory/appendToSessionHistory に同じ tenantId が渡る", async () => {
    await runDialogTurn({
      sessionId: "tenant-propagation-session",
      tenantId: "tenant-x",
      message: "こんにちは",
    });

    expect(mockGetHistory).toHaveBeenCalledWith("tenant-x", "tenant-propagation-session");
    expect(mockAppendHistory).toHaveBeenCalledWith(
      "tenant-x",
      "tenant-propagation-session",
      expect.any(Array)
    );
  });

  it("tenantId 未指定（undefined）の場合、DEFAULT_TENANT_ID にフォールバックする（この既定挙動により tenantId 省略時は全リクエストが同一テナントの履歴を共有する残存リスクがある）", async () => {
    await runDialogTurn({
      sessionId: "tenant-propagation-session-default",
      message: "こんにちは",
    } as any);

    const defaultTenantId = process.env.DEFAULT_TENANT_ID ?? "english-demo";
    expect(mockGetHistory).toHaveBeenCalledWith(defaultTenantId, "tenant-propagation-session-default");
  });

  it("tenantId が空文字列の場合、空文字列がそのまま tenantId として使われる（DEFAULT_TENANT_ID にフォールバックしない ── `??` は空文字列を「値あり」とみなすため）", async () => {
    await runDialogTurn({
      sessionId: "tenant-propagation-session-empty",
      tenantId: "",
      message: "こんにちは",
    });

    // "" ?? DEFAULT は "" を返す（null/undefined のみフォールバックする ?? の仕様どおり）。
    // 呼び出し元がテナント未解決を空文字列で表現すると、DEFAULT_TENANT_ID 保護を素通りする点に注意。
    expect(mockGetHistory).toHaveBeenCalledWith("", "tenant-propagation-session-empty");
  });

  it("同じ sessionId でも tenantId が異なれば別々に history を要求する", async () => {
    await runDialogTurn({
      sessionId: "shared-session-id",
      tenantId: "tenant-y",
      message: "tenant-y から",
    });
    await runDialogTurn({
      sessionId: "shared-session-id",
      tenantId: "tenant-z",
      message: "tenant-z から",
    });

    expect(mockGetHistory).toHaveBeenNthCalledWith(1, "tenant-y", "shared-session-id");
    expect(mockGetHistory).toHaveBeenNthCalledWith(2, "tenant-z", "shared-session-id");
  });
});
