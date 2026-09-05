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
  mockSalesFlow.mockResolvedValue({
    nextStage: undefined,
    prompt: undefined,
    meta: {} as any,
  });
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

describe("runDialogTurn — 資料オファー機能 resourceCard", () => {
  const mockGetSalesSessionMeta = getSalesSessionMeta as jest.MockedFunction<typeof getSalesSessionMeta>;
  const mockUpdateSalesSessionMeta = updateSalesSessionMeta as jest.MockedFunction<typeof updateSalesSessionMeta>;

  beforeEach(() => {
    mockGetSalesSessionMeta.mockReturnValue(undefined);
  });

  it("セールスintent未検出(閲覧中と推定)・公開済み資料ありならresourceCardが設定される(confidenceは本番実値のmedium)", async () => {
    // multiStepPlanner.ts は confidence を 'medium' に固定しており(確認済み)、
    // 主信号はあくまで「セールスintentが1つも検出されていないこと」。
    mockPlanner.mockResolvedValue({ ...basePlan, confidence: "medium" });
    mockDetectIntents.mockReturnValue({
      proposeIntent: undefined,
      recommendIntent: undefined,
      closeIntent: undefined,
    });
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ enabled: null }] }) // isSalesStageContinuityEnabled
      .mockResolvedValueOnce({
        rows: [
          {
            id: "res-1",
            tenant_id: "test-tenant",
            title: "導入事例集",
            description: null,
            storage_path: null,
            external_url: "https://example.com/whitepaper.pdf",
            file_type: "pdf",
            moderation_status: "approved",
            moderation_reason: null,
            rights_confirmed: true,
            is_published: true,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      });

    const result = await runDialogTurn({
      sessionId: "test-session-r1",
      tenantId: "test-tenant",
      message: "ちょっと見てるだけです",
    });

    expect(result.resourceCard).toEqual({
      title: "導入事例集",
      url: "https://example.com/whitepaper.pdf",
    });
    expect(mockUpdateSalesSessionMeta).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "test-tenant", sessionId: "test-session-r1" }),
      expect.objectContaining({ resourceOfferShown: true }),
    );
  });

  it("セールスintent未検出でも資料が無ければresourceCardは設定されない", async () => {
    mockPlanner.mockResolvedValue({ ...basePlan, confidence: "medium" });
    mockDetectIntents.mockReturnValue({
      proposeIntent: undefined,
      recommendIntent: undefined,
      closeIntent: undefined,
    });
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ enabled: null }] })
      .mockResolvedValueOnce({ rows: [] }); // tenant_resources 未登録

    const result = await runDialogTurn({
      sessionId: "test-session-r2",
      tenantId: "test-tenant",
      message: "ちょっと見てるだけです",
    });

    expect(result.resourceCard).toBeUndefined();
  });

  it("資料はあるが is_published=false のときは resourceCard を設定しない(下書き/モデレーション未通過をLLMのシグナルだけで公開しない)", async () => {
    mockPlanner.mockResolvedValue({ ...basePlan, confidence: "medium" });
    mockDetectIntents.mockReturnValue({
      proposeIntent: undefined,
      recommendIntent: undefined,
      closeIntent: undefined,
    });
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ enabled: null }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "res-1",
            tenant_id: "test-tenant",
            title: "下書き資料",
            description: null,
            storage_path: null,
            external_url: "https://example.com/draft.pdf",
            file_type: "pdf",
            moderation_status: "pending",
            moderation_reason: null,
            rights_confirmed: true,
            is_published: false,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      });

    const result = await runDialogTurn({
      sessionId: "test-session-r3",
      tenantId: "test-tenant",
      message: "ちょっと見てるだけです",
    });

    expect(result.resourceCard).toBeUndefined();
  });

  it("is_published=true でも moderation_status='rejected' なら resourceCard を設定しない(多層防御: publishエンドポイントのTOCTOU競合で理論上生じうる不整合行を信用しない)", async () => {
    mockPlanner.mockResolvedValue({ ...basePlan, confidence: "medium" });
    mockDetectIntents.mockReturnValue({
      proposeIntent: undefined,
      recommendIntent: undefined,
      closeIntent: undefined,
    });
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ enabled: null }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "res-1",
            tenant_id: "test-tenant",
            title: "却下済みのはずが公開フラグが残った資料",
            description: null,
            storage_path: null,
            external_url: "https://example.com/rejected.pdf",
            file_type: "pdf",
            moderation_status: "rejected",
            moderation_reason: "著作権侵害の疑い",
            rights_confirmed: true,
            is_published: true, // 本来あり得ないが、TOCTOU競合で理論上発生しうる組み合わせ
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      });

    const result = await runDialogTurn({
      sessionId: "test-session-r-rejected",
      tenantId: "test-tenant",
      message: "ちょっと見てるだけです",
    });

    expect(result.resourceCard).toBeUndefined();
  });

  it("セールスintentが検出済み(confidenceも本番実値のmedium)なら資料オファーより成約導線を優先し問い合わせしない", async () => {
    mockPlanner.mockResolvedValue({ ...basePlan, confidence: "medium" });
    mockDetectIntents.mockReturnValue({
      proposeIntent: "trial_lesson_offer",
      recommendIntent: undefined,
      closeIntent: undefined,
    });
    mockPool.query.mockResolvedValueOnce({ rows: [{ enabled: null }] });

    const result = await runDialogTurn({
      sessionId: "test-session-r5",
      tenantId: "test-tenant",
      message: "料金を教えて",
    });

    expect(result.resourceCard).toBeUndefined();
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it("セールスintentが検出済みでも confidence==='low' なら副次的なOR条件として資料の有無を問い合わせる" +
    "(現状のrule-based multiStepPlannerはconfidenceを'medium'固定で返すためこの分岐には到達しないが、" +
    "将来confidence算出が実質化されても壊れないことを固定する。この分岐が実際に効くようになったからといって" +
    "LLM JSON経路(useLlmPlanner)を有効化する理由にはならない)", async () => {
    mockPlanner.mockResolvedValue({ ...basePlan, confidence: "low" });
    mockDetectIntents.mockReturnValue({
      proposeIntent: "trial_lesson_offer",
      recommendIntent: undefined,
      closeIntent: undefined,
    });
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ enabled: null }] })
      .mockResolvedValueOnce({ rows: [] }); // tenant_resources 未登録(問い合わせ自体が発生したことだけを確認する)

    const result = await runDialogTurn({
      sessionId: "test-session-r5b",
      tenantId: "test-tenant",
      message: "料金を教えて",
    });

    expect(result.resourceCard).toBeUndefined(); // 資料自体が無いのでカードは出ない
    expect(mockPool.query).toHaveBeenCalledTimes(2); // だが問い合わせ自体は発生した(信号が立った証拠)
  });

  it("1会話につき1回まで: salesContextStoreにresourceOfferShown=trueが記録済みなら資料の有無を再度問い合わせない", async () => {
    mockPlanner.mockResolvedValue({ ...basePlan, confidence: "medium" });
    mockDetectIntents.mockReturnValue({
      proposeIntent: undefined,
      recommendIntent: undefined,
      closeIntent: undefined,
    });
    mockGetSalesSessionMeta.mockReturnValue({
      currentStage: "clarify",
      resourceOfferShown: true,
      lastUpdatedAt: "2026-01-01T00:00:00.000Z",
    });
    mockPool.query.mockResolvedValueOnce({ rows: [{ enabled: null }] });

    const result = await runDialogTurn({
      sessionId: "test-session-r6",
      tenantId: "test-tenant",
      message: "他にもありますか",
    });

    expect(result.resourceCard).toBeUndefined();
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(mockUpdateSalesSessionMeta).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resourceOfferShown: true }),
    );
  });

  it("資料の存在確認(DB問い合わせ)が例外を投げてもresourceCardなしで正常応答する", async () => {
    mockPlanner.mockResolvedValue({ ...basePlan, confidence: "medium" });
    mockDetectIntents.mockReturnValue({
      proposeIntent: undefined,
      recommendIntent: undefined,
      closeIntent: undefined,
    });
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ enabled: null }] })
      .mockRejectedValueOnce(new Error('relation "tenant_resources" does not exist'));

    const result = await runDialogTurn({
      sessionId: "test-session-r7",
      tenantId: "test-tenant",
      message: "ちょっと見てるだけです",
    });

    // エラーは握りつぶされ resourceCard なしで正常応答する(answer自体は他要因で決まるため未検証)
    expect(result.resourceCard).toBeUndefined();
    expect(result.answer).not.toBeNull();
  });

  it("LLMの自由文(回答テキスト)にどんな文言があってもresourceCardの判定には使わない(構造化フィールドのみで決まる)", async () => {
    mockPlanner.mockResolvedValue({ ...basePlan, confidence: "medium" });
    mockDetectIntents.mockReturnValue({
      proposeIntent: undefined,
      recommendIntent: undefined,
      closeIntent: undefined,
    });
    mockOrchestrator.mockResolvedValue({
      ...baseOrchestrated,
      answer: "資料をご案内しました。詳しくはこちらをご覧ください。",
    });
    mockPool.query.mockResolvedValueOnce({ rows: [{ enabled: null }] }).mockResolvedValueOnce({ rows: [] });

    const result = await runDialogTurn({
      sessionId: "test-session-r8",
      tenantId: "test-tenant",
      message: "ちょっと見てるだけです",
    });

    // 回答テキストに「案内しました」等の文言があっても、DBに資料が無ければ設定されない
    expect(result.resourceCard).toBeUndefined();
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

// Phase69-2 [外1] GID 1218086284362759: /dialog/turn の options.excluded_ids が
// 黙って捨てられていた事故の再発防止。
//
// tenants.default_excluded_ids の fetch/merge はルートハンドラ側(src/index.ts)に
// 置くことにした（runDialogTurn は /api/chat からも呼ばれる共有関数のため、
// ここに fetch を置くと /api/chat の全トラフィックに無条件のDB往復が
// 増えてしまう — レビュー指摘により dialogAgent.ts から撤去済み）。
// そのためここで検証するのは「runDialogTurn は受け取った options.excluded_ids
// をそのまま options.excludedIds として orchestrator に橋渡しするだけ」という
// 純粋な配管であることと、その過程で DB 呼び出しを一切増やさないこと。
// マージ計算自体（重複除去・優先順位）は src/lib/defaultExcludedIds.test.ts、
// ルートハンドラでの fetch+merge 配線は src/index.dialogTurnExcludedIds.test.ts /
// src/index.wiringInvariants.test.ts が検証する。
describe("runDialogTurn — Phase69-2 [外1] excluded_ids 配線（純粋な橋渡し）", () => {
  it("options.excluded_ids を runDialogOrchestrator の options.excludedIds としてそのまま渡す", async () => {
    await runDialogTurn({
      sessionId: "test-session-excluded-1",
      tenantId: "tenant-a",
      message: "返品ポリシーを教えて",
      options: { excluded_ids: ["id-1", "id-2"] },
    });

    expect(mockOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          excludedIds: ["id-1", "id-2"],
        }),
      })
    );
  });

  it("options.excluded_ids が未指定の場合、excludedIds は undefined のまま渡る（既定除外の付与はルート側の責務）", async () => {
    await runDialogTurn({
      sessionId: "test-session-excluded-2",
      tenantId: "tenant-a",
      message: "こんにちは",
    });

    const callArgs = mockOrchestrator.mock.calls[0]![0];
    expect(callArgs.options?.excludedIds).toBeUndefined();
  });

  // レビュー指摘の再発防止(本命): runDialogTurn 自身は default_excluded_ids の
  // ための DB クエリを発行しない。/api/chat 経由の全トラフィックへ無条件の
  // SELECT を増やさないことを直接固定する。
  it("excluded_ids の処理のために pool.query を追加で呼ばない（/api/chat への副作用防止）", async () => {
    mockPool.query.mockClear();

    await runDialogTurn({
      sessionId: "test-session-excluded-3",
      tenantId: "tenant-a",
      message: "こんにちは",
      options: { excluded_ids: ["id-1"] },
    });

    // このテストで発生する pool.query は PR-11 の features フラグ読み取り
    // (isSalesStageContinuityEnabled)の1回のみ。default_excluded_ids 用の
    // クエリが増えていないことを件数で固定する。
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });
});
