// src/lib/metrics/metricsFlush.test.ts
// Phase72-D: metricsFlush ユニットテスト

// ---------------------------------------------------------------------------
// prom-client モック（metricsRegistry.getMetricsAsJSON を制御）
// ---------------------------------------------------------------------------

const mockGetMetricsAsJSON = jest.fn();
jest.mock("./promExporter", () => ({
  metricsRegistry: {
    getMetricsAsJSON: (...args: unknown[]) => mockGetMetricsAsJSON(...args),
  },
}));

// ---------------------------------------------------------------------------
// Pool モック
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();
const mockPool = { query: (...args: unknown[]) => mockQuery(...args) };

// ---------------------------------------------------------------------------
// Logger モック
// ---------------------------------------------------------------------------

const mockWarn = jest.fn();
const mockInfo = jest.fn();
const mockLogger = { warn: mockWarn, info: mockInfo };

import { initMetricsFlush } from "./metricsFlush";
import { KPI_METRIC_NAMES } from "./kpiDefinitions";

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// pool 未初期化
// ---------------------------------------------------------------------------

describe("initMetricsFlush — pool 未初期化", () => {
  it("pool=null のとき warn を出して cleanup 関数を返す（タイマーなし）", () => {
    const cleanup = initMetricsFlush(null, mockLogger as any, 1000);
    expect(mockWarn).toHaveBeenCalledWith(
      "[metricsFlush] pool not initialized, flush disabled",
    );
    // タイマーが仕掛けられていないことを確認（setInterval 呼ばれない）
    expect(typeof cleanup).toBe("function");
    cleanup(); // エラーにならないこと
  });
});

// ---------------------------------------------------------------------------
// Counter delta 正計算
// ---------------------------------------------------------------------------

describe("initMetricsFlush — Counter delta", () => {
  it("Counter の delta（前回値との差分）を INSERT する", async () => {
    // 1 回目の flush で value=10
    mockGetMetricsAsJSON.mockResolvedValue([
      {
        name: KPI_METRIC_NAMES.CONVERSATION_TERMINAL_TOTAL,
        type: "counter",
        values: [{ labels: { reason: "completed", tenantId: "t1" }, value: 10 }],
      },
    ]);
    mockQuery.mockResolvedValue({ rows: [] });

    const cleanup = initMetricsFlush(mockPool as any, mockLogger as any, 5000);

    // 最初の tick（5000ms 後）
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    // delta = 10 - 0 = 10
    const firstCall = mockQuery.mock.calls[0];
    expect(firstCall[1]).toContain(KPI_METRIC_NAMES.CONVERSATION_TERMINAL_TOTAL);
    expect(firstCall[1]).toContain(10); // value = delta

    // 2 回目: value=15 → delta=5
    mockGetMetricsAsJSON.mockResolvedValue([
      {
        name: KPI_METRIC_NAMES.CONVERSATION_TERMINAL_TOTAL,
        type: "counter",
        values: [{ labels: { reason: "completed", tenantId: "t1" }, value: 15 }],
      },
    ]);
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const secondCall = mockQuery.mock.calls[1];
    expect(secondCall[1]).toContain(5); // delta = 15 - 10 = 5

    cleanup();
  });

  it("delta が 0 以下（デクリメント）のときは INSERT しない", async () => {
    // 1 回目: value=20 → prev=0, delta=20 → INSERT
    mockGetMetricsAsJSON.mockResolvedValueOnce([
      {
        name: KPI_METRIC_NAMES.LOOP_DETECTED_TOTAL,
        type: "counter",
        values: [{ labels: { tenantId: "t1" }, value: 20 }],
      },
    ]);
    mockQuery.mockResolvedValue({ rows: [] });
    const cleanup = initMetricsFlush(mockPool as any, mockLogger as any, 5000);
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // 2 回目: value=20（変化なし）→ delta=0 → INSERT しない
    mockGetMetricsAsJSON.mockResolvedValueOnce([
      {
        name: KPI_METRIC_NAMES.LOOP_DETECTED_TOTAL,
        type: "counter",
        values: [{ labels: { tenantId: "t1" }, value: 20 }],
      },
    ]);
    await jest.advanceTimersByTimeAsync(5000);
    // delta=0 なので INSERT 呼ばれない（前と同じ 1 回のまま）
    expect(mockQuery).toHaveBeenCalledTimes(1);

    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Histogram count=0 の divide-by-zero なし
// ---------------------------------------------------------------------------

describe("initMetricsFlush — Histogram", () => {
  it("count=0 の Histogram バケットは INSERT しない（divide-by-zero ガード）", async () => {
    mockGetMetricsAsJSON.mockResolvedValue([
      {
        name: KPI_METRIC_NAMES.RAG_DURATION_MS,
        type: "histogram",
        values: [
          // le バケット（count=0）: +Inf value=0
          { labels: { phase: "embed", tenantId: "t1", le: "+Inf" }, value: 0 },
          // sum エントリ（le なし）: value=0
          { labels: { phase: "embed", tenantId: "t1" }, value: 0 },
        ],
      },
    ]);
    mockQuery.mockResolvedValue({ rows: [] });

    const cleanup = initMetricsFlush(mockPool as any, mockLogger as any, 5000);
    await jest.advanceTimersByTimeAsync(5000);

    // count=0 なので INSERT されない
    expect(mockQuery).not.toHaveBeenCalled();
    cleanup();
  });

  it("count>0 の Histogram は sum/count = avg を INSERT する", async () => {
    // sum=3000ms, count=3 → avg=1000ms
    mockGetMetricsAsJSON.mockResolvedValue([
      {
        name: KPI_METRIC_NAMES.RAG_DURATION_MS,
        type: "histogram",
        values: [
          { labels: { phase: "search", tenantId: "t2", le: "+Inf" }, value: 3 }, // count=3
          { labels: { phase: "search", tenantId: "t2" }, value: 3000 },          // sum=3000
        ],
      },
    ]);
    mockQuery.mockResolvedValue({ rows: [] });

    const cleanup = initMetricsFlush(mockPool as any, mockLogger as any, 5000);
    await jest.advanceTimersByTimeAsync(5000);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0];
    // value = 3000/3 = 1000
    expect(call[1]).toContain(1000);
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// cleanup 関数
// ---------------------------------------------------------------------------

describe("initMetricsFlush — cleanup", () => {
  it("cleanup() を呼ぶとタイマーが停止し、その後 flush が発生しない", async () => {
    mockGetMetricsAsJSON.mockResolvedValue([]);
    const cleanup = initMetricsFlush(mockPool as any, mockLogger as any, 5000);

    // 1 tick
    await jest.advanceTimersByTimeAsync(5000);
    const callsBefore = mockQuery.mock.calls.length;

    cleanup();

    // cleanup 後は追加呼び出しなし
    await jest.advanceTimersByTimeAsync(15000);
    expect(mockQuery.mock.calls.length).toBe(callsBefore);
  });
});
