// src/lib/gemini/client.test.ts
//
// E3(trackUsage計上)の壊れやすいポイントを検証する:
//   - 呼び出し元省略時は billable:false・featureUsed:'admin_tuning'（R2C運用コストのみ計上、
//     Stripe請求数量に含めない）
//   - usageMetadataが欠落した異常なレスポンスでも例外を投げず0トークンとして安全に計上する
//   - 外部APIが失敗した場合、trackUsageは呼ばれない（＝失敗コールのコストは現状可視化されない
//     残存リスク。GEMINI_API_KEY課金は発生しうるため、この非対称は既知の限界として明記する）
//   - trackUsageの呼び出しはレスポンステキストの取得をブロックしない

const mockTrackUsage = jest.fn();
jest.mock("../billing/usageTracker", () => ({
  trackUsage: (...args: unknown[]) => mockTrackUsage(...args),
}));

import { callGeminiJudge } from "./client";

const ORIGINAL_API_KEY = process.env.GEMINI_API_KEY;

function mockFetchOk(text: string, promptTokenCount = 100, candidatesTokenCount = 50) {
  (global as any).fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount, candidatesTokenCount },
    }),
  });
}

beforeEach(() => {
  process.env.GEMINI_API_KEY = "test-key";
  mockTrackUsage.mockClear();
});

afterEach(() => {
  process.env.GEMINI_API_KEY = ORIGINAL_API_KEY;
  delete (global as any).fetch;
});

describe("callGeminiJudge — 正常系", () => {
  it("成功時にレスポンステキストを返し、trackUsageを実トークン数で1回呼ぶ", async () => {
    mockFetchOk("判定結果です", 120, 60);
    const text = await callGeminiJudge("この応答を評価して");

    expect(text).toBe("判定結果です");
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 120,
        outputTokens: 60,
        featureUsed: "admin_tuning",
        billable: false,
      }),
    );
  });

  it("tenantId/billableを明示指定した場合はそれが優先される（テナント課金対象にできる余地を確認）", async () => {
    mockFetchOk("ok");
    await callGeminiJudge("prompt", { tenantId: "tenant-a", billable: true, requestId: "req-x" });

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-a", billable: true, requestId: "req-x" }),
    );
  });
});

describe("callGeminiJudge — 境界値・異常系", () => {
  it("usageMetadataが欠落したレスポンスでも例外を投げず0トークンで計上する", async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), // usageMetadata省略
    });
    const text = await callGeminiJudge("prompt");
    expect(text).toBe("ok");
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0 }),
    );
  });

  it("candidatesが空配列の異常なレスポンスでも例外を投げず空文字を返す（LLM出力欠落を無言で握りつぶさないよう、呼び出し元での空文字ハンドリングが前提になる点に注意）", async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [] }),
    });
    const text = await callGeminiJudge("prompt");
    expect(text).toBe("");
    // 空応答でもコスト自体は発生しているためtrackUsageは呼ばれる
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
  });

  it("GEMINI_API_KEY未設定はfetchを呼ばずthrowし、trackUsageも呼ばれない", async () => {
    delete process.env.GEMINI_API_KEY;
    (global as any).fetch = jest.fn();
    await expect(callGeminiJudge("prompt")).rejects.toThrow(/GEMINI_API_KEY not set/);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("既知の残存リスク: 外部APIが5xx/4xxで失敗した場合、trackUsageは呼ばれずコストが可視化されない（本テストは現状のこの非対称な挙動を固定するもので、是正はスコープ外）", async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });
    await expect(callGeminiJudge("prompt")).rejects.toThrow(/Gemini API error: 429/);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("fetch自体がネットワークエラーで例外を投げた場合もtrackUsageは呼ばれず、例外がそのまま伝播する", async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(callGeminiJudge("prompt")).rejects.toThrow("ECONNRESET");
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("[修正確認] trackUsageが同期的に例外を投げても呼び出し元でtry/catchされ、正常取得できたJudge結果は失われずそのまま返る",
  async () => {
    mockFetchOk("大事な判定結果");
    mockTrackUsage.mockImplementationOnce(() => {
      throw new Error("db pool exploded");
    });
    await expect(callGeminiJudge("prompt")).resolves.toBe("大事な判定結果");
  });
});
