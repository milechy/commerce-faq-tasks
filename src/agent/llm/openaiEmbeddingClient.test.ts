// src/agent/llm/openaiEmbeddingClient.test.ts
//
// E3(trackUsage計上)の壊れやすいポイントを検証する:
//   - NODE_ENV==='test' の早期return分岐は fetch/trackUsage を一切通らない
//     (このテストファイル自体が jest 実行中は常に NODE_ENV==='test' のため、
//      本番相当の分岐を検証するには describe 内で明示的に上書きし、必ず afterEach で
//      復元する。復元漏れは他ファイルのテストへ波及する — 過去に実際そのクラスの
//      回帰でテストスイート全体が壊れた実績があるため、try/finally 相当で確実に戻す)
//   - trackUsage は fire-and-forget (setImmediate) で呼び出し元の返り値をブロック/破壊しない
//   - tenantId 省略時は billable:false + tenantId:'unknown' で計上される
//   - 外部API失敗時は trackUsage が呼ばれない(コストは計上されない)
//   - 同一呼び出しでtrackUsageが二重に呼ばれない

const mockTrackUsage = jest.fn();
jest.mock("../../lib/billing/usageTracker", () => ({
  trackUsage: (...args: unknown[]) => mockTrackUsage(...args),
}));

import { embedText, embedTextOpenAI, embedTextWithUsage } from "./openaiEmbeddingClient";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_API_KEY = process.env.OPENAI_API_KEY;

function mockFetchOk(totalTokens = 42) {
  (global as any).fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
      usage: { total_tokens: totalTokens },
    }),
  });
}

function mockFetchFail(status = 500, body = "internal error") {
  (global as any).fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    text: async () => body,
  });
}

describe("openaiEmbeddingClient — NODE_ENV==='test' 早期return（既存の前提挙動）", () => {
  it("fetchもtrackUsageも呼ばずにダミーembeddingを返す", async () => {
    expect(process.env.NODE_ENV).toBe("test");
    (global as any).fetch = jest.fn();
    const result = await embedTextWithUsage("hello");
    expect(result.embedding).toHaveLength(1536);
    expect(result.totalTokens).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });
});

describe("openaiEmbeddingClient — 本番相当分岐（NODE_ENV一時的に上書き）", () => {
  beforeEach(() => {
    // テスト用に一時的に書き換える
    process.env.NODE_ENV = "production";
    process.env.OPENAI_API_KEY = "test-key";
    mockTrackUsage.mockClear();
  });

  afterEach(() => {
    // 復元漏れは他ファイルのテストに波及するため必ず戻す
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    process.env.OPENAI_API_KEY = ORIGINAL_API_KEY;
    delete (global as any).fetch;
  });

  it("正常系: 成功時にtrackUsageが正しいパラメータで1回だけ呼ばれる", async () => {
    mockFetchOk(42);
    const result = await embedTextWithUsage("hello world", { tenantId: "tenant-a", requestId: "req-1" });

    expect(result.totalTokens).toBe(42);
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        requestId: "req-1",
        inputTokens: 42,
        outputTokens: 0,
        featureUsed: "admin_guide",
        billable: undefined, // tenantId指定時はfeatureUsedの自動判定に委ねる
      }),
    );
  });

  it("境界値: tenantId未指定時はbillable:falseかつtenantId:'unknown'で計上される", async () => {
    mockFetchOk(10);
    await embedTextWithUsage("no tenant context");

    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "unknown", billable: false }),
    );
  });

  it("異常系: 外部APIが失敗した場合はtrackUsageを呼ばずthrowする（コスト未計上のまま失敗が伝播する）", async () => {
    mockFetchFail(500, "rate limited");
    await expect(embedTextWithUsage("boom")).rejects.toThrow(/OpenAI embeddings failed: 500/);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("異常系: OPENAI_API_KEY未設定はfetchすら呼ばずthrowする", async () => {
    delete process.env.OPENAI_API_KEY;
    (global as any).fetch = jest.fn();
    await expect(embedTextWithUsage("no key")).rejects.toThrow(/OPENAI_API_KEY is not set/);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("異常系: レスポンスにembeddingが無い不正な形状でもtrackUsageは呼ばず安全にthrowする", async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{}], usage: { total_tokens: 5 } }),
    });
    await expect(embedTextWithUsage("malformed")).rejects.toThrow(/embedding not found/);
    expect(mockTrackUsage).not.toHaveBeenCalled();
  });

  it("境界値: usage.total_tokensが欠落したレスポンスでも例外を投げず0として計上する", async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1] }] }), // usage省略
    });
    const result = await embedTextWithUsage("no usage field", { tenantId: "tenant-a" });
    expect(result.totalTokens).toBe(0);
    expect(mockTrackUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 0 }));
  });

  it("イレギュラー: 同一text・同一tenantIdで連続呼び出ししてもrequestIdが毎回異なり、trackUsageは呼び出し回数分だけ呼ばれる（二重計上防止はDBのON CONFLICTに委ねられており、ここでは呼び出し側が重複排除しないことを固定する）", async () => {
    mockFetchOk(1);
    await embedTextWithUsage("same text", { tenantId: "tenant-a" });
    await embedTextWithUsage("same text", { tenantId: "tenant-a" });

    expect(mockTrackUsage).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = mockTrackUsage.mock.calls;
    // requestId省略時は呼び出し毎に新規生成される → リトライラッパーがrequestIdを
    // 明示的に引き継がない限り、再試行のたびに別行として二重計上されるリスクが残る。
    expect(firstCall[0].requestId).not.toBe(secondCall[0].requestId);
  });

  it("[修正確認] trackUsageが同期的に例外を投げても呼び出し元でtry/catchされ、正常取得できたembedding結果は失われずそのまま返る", async () => {
    mockFetchOk(7);
    mockTrackUsage.mockImplementationOnce(() => {
      throw new Error("db pool exploded");
    });
    const result = await embedTextWithUsage("resilient", { tenantId: "tenant-a" });
    expect(result.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(result.totalTokens).toBe(7);
  });

  it("embedText/embedTextOpenAI（互換ラッパー）もtrackUsageを同様に発火させる", async () => {
    mockFetchOk(3);
    const embedding = await embedText("via embedText");
    expect(embedding).toEqual([0.1, 0.2, 0.3]);
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);

    mockTrackUsage.mockClear();
    mockFetchOk(4);
    await embedTextOpenAI("via embedTextOpenAI");
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
  });
});
