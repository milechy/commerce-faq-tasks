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

/** マイクロタスクキューを全て処理してから進む（void Promise の解決待ち用） */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

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
    expect(typeof cleanup).toBe("function");
    cleanup(); // エラーにならないこと
  });
});

// ---------------------------------------------------------------------------
// warm-up: 初回 flush は Counter を INSERT しない（P1-2 regression guard）
// ---------------------------------------------------------------------------

describe("initMetricsFlush — warm-up dry-run", () => {
  it("initMetricsFlush 直後（タイマー tick 前）は Counter を INSERT しない", async () => {
    // warm-up dryRun の getMetricsAsJSON 呼び出し用
    mockGetMetricsAsJSON.mockResolvedValue([
      {
        name: KPI_METRIC_NAMES.CONVERSATION_TERMINAL_TOTAL,
        type: "counter",
        values: [{ labels: { reason: "completed", tenantId: "t1" }, value: 999 }],
      },
    ]);
    mockQuery.mockResolvedValue({ rows: [] });

    const cleanup = initMetricsFlush(mockPool as any, mockLogger as any, 5000);

    // warm-up の void Promise を解決させる
    await flushMicrotasks();

    // dryRun なので INSERT は呼ばれないこと
    expect(mockQuery).not.toHaveBeenCalled();

    cleanup();
  });

  it("warm-up 後の最初の tick では累積値ではなく warm-up 以降の delta だけ INSERT する", async () => {
    // warm-up: value=500（大きな累積値）
    mockGetMetricsAsJSON.mockResolvedValueOnce([
      {
        name: KPI_METRIC_NAMES.CONVERSATION_TERMINAL_TOTAL,
        type: "counter",
        values: [{ labels: { reason: "completed", tenantId: "t1" }, value: 500 }],
      },
    ]);
    mockQuery.mockResolvedValue({ rows: [] });

    const cleanup = initMetricsFlush(mockPool as any, mockLogger as any, 5000);
    await flushMicrotasks(); // warm-up dryRun 完了

    // 1st tick: value=503 → delta = 503 - 500 = 3（500 はスパイクしない）
    mockGetMetricsAsJSON.mockResolvedValueOnce([
      {
        name: KPI_METRIC_NAMES.CONVERSATION_TERMINAL_TOTAL,
        type: "counter",
        values: [{ labels: { reason: "completed", tenantId: "t1" }, value: 503 }],
      },
    ]);
    await jest.advanceTimersByTimeAsync(5000);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = mockQuery.mock.calls[0];
    // INSERT params に delta=3 が含まれ、累積値 500 は含まれない
    expect(call[1]).toContain(3);
    expect(call[1]).not.toContain(500);

    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Counter delta 正計算
// ---------------------------------------------------------------------------

describe("initMetricsFlush — Counter delta", () => {
  it("Counter の delta（前回値との差分）を INSERT する", async () => {
    // warm-up: value=0（新規プロセス相当）
    mockGetMetricsAsJSON.mockResolvedValueOnce([
      {
        name: KPI_METRIC_NAMES.CONVERSATION_TERMINAL_TOTAL,
        type: "counter",
        values: [{ labels: { reason: "completed", tenantId: "t1" }, value: 0 }],
      },
    ]);
    mockQuery.mockResolvedValue({ rows: [] });

    const cleanup = initMetricsFlush(mockPool as any, mockLogger as any, 5000);
    await flushMicrotasks(); // warm-up

    // 1 回目の tick: value=10 → delta=10
    mockGetMetricsAsJSON.mockResolvedValueOnce([
      {
        name: KPI_METRIC_NAMES.CONVERSATION_TERMINAL_TOTAL,
        type: "counter",
        values: [{ labels: { reason: "completed", tenantId: "t1" }, value: 10 }],
      },
    ]);
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const firstCall = mockQuery.mock.calls[0];
    // INSERT params: metric_name, tenant_id, labels, value, snapshot_at
    expect(firstCall[1]).toContain(KPI_METRIC_NAMES.CONVERSATION_TERMINAL_TOTAL);
    expect(firstCall[1]).toContain("t1");   // tenant_id カラムに格納
    expect(firstCall[1]).toContain(10);     // delta

    // 2 回目: value=15 → delta=5
    mockGetMetricsAsJSON.mockResolvedValueOnce([
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

  it("tenantId が labels JSONB から除去され tenant_id カラムに分離される（PII anti-slop）", async () => {
    // warm-up
    mockGetMetricsAsJSON.mockResolvedValueOnce([
      {
        name: KPI_METRIC_NAMES.AVATAR_REQUESTS_TOTAL,
        type: "counter",
        values: [{ labels: { status: "success", tenantId: "tenant-abc" }, value: 0 }],
      },
    ]);
    mockQuery.mockResolvedValue({ rows: [] });
    const cleanup = initMetricsFlush(mockPool as any, mockLogger as any, 5000);
    await flushMicrotasks();

    // tick: value=7 → delta=7
    mockGetMetricsAsJSON.mockResolvedValueOnce([
      {
        name: KPI_METRIC_NAMES.AVATAR_REQUESTS_TOTAL,
        type: "counter",
        values: [{ labels: { status: "success", tenantId: "tenant-abc" }, value: 7 }],
      },
    ]);
    await jest.advanceTimersByTimeAsync(5000);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];

    // tenant_id がカラムとして INSERT される
    expect(sql).toContain("tenant_id");
    expect(params).toContain("tenant-abc");

    // labels JSONB に tenantId が含まれていないこと
    const labelsArg = params.find(
      (p) => typeof p === "object" && p !== null && !Array.isArray(p) && "status" in (p as object),
    ) as Record<string, unknown> | undefined;
    expect(labelsArg).toBeDefined();
    expect(labelsArg).not.toHaveProperty("tenantId");
    expect(labelsArg).toHaveProperty("status", "success");

    cleanup();
  });

  it("delta が 0 以下（変化なし）のときは INSERT しない", async () => {
    // warm-up: value=20
    mockGetMetricsAsJSON.mockResolvedValueOnce([
      {
        name: KPI_METRIC_NAMES.LOOP_DETECTED_TOTAL,
        type: "counter",
        values: [{ labels: { tenantId: "t1" }, value: 20 }],
      },
    ]);
    mockQuery.mockResolvedValue({ rows: [] });
    const cleanup = initMetricsFlush(mockPool as any, mockLogger as any, 5000);
    await flushMicrotasks();

    // 1st tick: value=25 → delta=5 → INSERT
    mockGetMetricsAsJSON.mockResolvedValueOnce([
      {
        name: KPI_METRIC_NAMES.LOOP_DETECTED_TOTAL,
        type: "counter",
        values: [{ labels: { tenantId: "t1" }, value: 25 }],
      },
    ]);
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    // 2nd tick: value=25（変化なし）→ delta=0 → INSERT しない
    mockGetMetricsAsJSON.mockResolvedValueOnce([
      {
        name: KPI_METRIC_NAMES.LOOP_DETECTED_TOTAL,
        type: "counter",
        values: [{ labels: { tenantId: "t1" }, value: 25 }],
      },
    ]);
    await jest.advanceTimersByTimeAsync(5000);
    expect(mockQuery).toHaveBeenCalledTimes(1); // 増えない

    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Histogram count=0 の divide-by-zero なし
// ---------------------------------------------------------------------------

describe("initMetricsFlush — Histogram", () => {
  it("count=0 の Histogram バケットは INSERT しない（divide-by-zero ガード）", async () => {
    // warm-up
    mockGetMetricsAsJSON.mockResolvedValueOnce([
      {
        name: KPI_METRIC_NAMES.RAG_DURATION_MS,
        type: "histogram",
        values: [
          { labels: { phase: "embed", tenantId: "t1", le: "+Inf" }, value: 0 },
          { labels: { phase: "embed", tenantId: "t1" }, value: 0 },
        ],
      },
    ]);
    mockQuery.mockResolvedValue({ rows: [] });

    const cleanup = initMetricsFlush(mockPool as any, mockLogger as any, 5000);
    await flushMicrotasks();

    // tick: count=0 のまま
    mockGetMetricsAsJSON.mockResolvedValueOnce([
      {
        name: KPI_METRIC_NAMES.RAG_DURATION_MS,
        type: "histogram",
        values: [
          { labels: { phase: "embed", tenantId: "t1", le: "+Inf" }, value: 0 },
          { labels: { phase: "embed", tenantId: "t1" }, value: 0 },
        ],
      },
    ]);
    await jest.advanceTimersByTimeAsync(5000);

    // count=0 なので INSERT されない
    expect(mockQuery).not.toHaveBeenCalled();
    cleanup();
  });

  it("count>0 の Histogram は sum/count = avg を INSERT し tenantId を tenant_id カラムに分離する", async () => {
    // warm-up
    mockGetMetricsAsJSON.mockResolvedValueOnce([
      {
        name: KPI_METRIC_NAMES.RAG_DURATION_MS,
        type: "histogram",
        values: [
          { labels: { phase: "search", tenantId: "t2", le: "+Inf" }, value: 3 },
          { labels: { phase: "search", tenantId: "t2" }, value: 3000 },
        ],
      },
    ]);
    mockQuery.mockResolvedValue({ rows: [] });

    const cleanup = initMetricsFlush(mockPool as any, mockLogger as any, 5000);
    await flushMicrotasks();

    // tick: sum=3000ms, count=3 → avg=1000ms
    mockGetMetricsAsJSON.mockResolvedValueOnce([
      {
        name: KPI_METRIC_NAMES.RAG_DURATION_MS,
        type: "histogram",
        values: [
          { labels: { phase: "search", tenantId: "t2", le: "+Inf" }, value: 3 },
          { labels: { phase: "search", tenantId: "t2" }, value: 3000 },
        ],
      },
    ]);
    await jest.advanceTimersByTimeAsync(5000);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toContain(1000);     // avg = 3000/3
    expect(params).toContain("t2");     // tenant_id カラム

    // labels JSONB に tenantId が含まれないこと
    const labelsArg = params.find(
      (p) => typeof p === "object" && p !== null && !Array.isArray(p) && "phase" in (p as object),
    ) as Record<string, unknown> | undefined;
    expect(labelsArg).toBeDefined();
    expect(labelsArg).not.toHaveProperty("tenantId");
    expect(labelsArg).toHaveProperty("phase", "search");

    void sql; // 参照のみ

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
    await flushMicrotasks();

    await jest.advanceTimersByTimeAsync(5000);
    const callsBefore = mockQuery.mock.calls.length;

    cleanup();

    await jest.advanceTimersByTimeAsync(15000);
    expect(mockQuery.mock.calls.length).toBe(callsBefore);
  });
});
