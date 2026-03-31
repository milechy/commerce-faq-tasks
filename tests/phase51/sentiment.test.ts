import { analyzeSentiment } from "../../src/lib/sentiment/client";

// fetchのモック
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe("analyzeSentiment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("正常なレスポンスでSentimentResultを返す", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ label: "positive", score: 0.85, raw_label: "positive" }),
    });

    const result = await analyzeSentiment("素晴らしい商品ですね");
    expect(result).toEqual({ label: "positive", score: 0.85, raw_label: "positive" });
  });

  it("HTTPエラー時にnullを返す", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    const result = await analyzeSentiment("test");
    expect(result).toBeNull();
  });

  it("ネットワークエラー時にthrowしない", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    await expect(analyzeSentiment("test")).resolves.toBeNull();
  });

  it("タイムアウト時にnullを返す", async () => {
    // AbortSignal が abort されたときに reject する mock
    mockFetch.mockImplementationOnce(
      (_url: string, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const signal = options?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }
        })
    );
    const promise = analyzeSentiment("test");
    // fake timer で 3100ms 進めて abort を発火させる
    jest.advanceTimersByTime(3100);
    const result = await promise;
    expect(result).toBeNull();
  }, 10000);
});
