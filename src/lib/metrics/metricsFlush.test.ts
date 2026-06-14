/**
 * Phase72-D: metricsFlush ユニットテスト
 *
 * - Counter delta 計算の確認
 * - Histogram sum の確認
 * - pool null 時に noop
 * - fake timers で clearInterval（stop 関数）の確認
 */

import { flushOnce, initMetricsFlush } from "./metricsFlush";
import {
  conversationTerminalCounter,
  loopDetectedCounter,
  ragDurationHistogram,
} from "./promExporter";
import pino from "pino";

// prom-client の Counter/Histogram が実際の in-memory 値を保持するため、
// テスト間でリセットが必要。metricsRegistry は各テストで reset しない
// （他テストとの干渉回避のため、reset メソッドをスパイする）

// ---------------------------------------------------------------------------
// Mock pool
// ---------------------------------------------------------------------------

function makeMockPool() {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    query: jest.fn().mockImplementation((text: string, values: unknown[]) => {
      queries.push({ text, values });
      return Promise.resolve({ rows: [] });
    }),
    _queries: queries,
  };
  return pool as unknown as import("pg").Pool & { _queries: typeof queries };
}

const logger = pino({ level: "silent" });

// ---------------------------------------------------------------------------
// Tests: flushOnce
// ---------------------------------------------------------------------------

describe("flushOnce", () => {
  beforeEach(() => {
    // Counter/Histogram を reset してテスト間の干渉を排除
    conversationTerminalCounter.reset();
    loopDetectedCounter.reset();
    ragDurationHistogram.reset();
  });

  it("Counter に増分がある場合 INSERT を実行する", async () => {
    const pool = makeMockPool();

    conversationTerminalCounter.labels({ reason: "completed", tenantId: "tenant-A" }).inc(3);

    await flushOnce(pool, logger);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const call = pool._queries[0];
    expect(call.text).toMatch(/INSERT INTO metrics_snapshots/);
    // value = 3 が含まれる
    expect(call.values).toContain(3);
    // metric_name が含まれる
    expect(call.values).toContain("rajiuce_conversation_terminal_total");
    // tenant_id = "tenant-A"
    expect(call.values).toContain("tenant-A");
  });

  it("Counter 2回 flush で2回目は delta が 0 なので INSERT しない", async () => {
    const pool = makeMockPool();

    loopDetectedCounter.labels({ tenantId: "tenant-B" }).inc(2);

    // 1回目: delta = 2 → INSERT
    await flushOnce(pool, logger);
    expect(pool.query).toHaveBeenCalledTimes(1);

    (pool.query as jest.Mock).mockClear();
    pool._queries.length = 0;

    // 2回目: 増分なし → INSERT しない
    await flushOnce(pool, logger);
    expect(pool.query).toHaveBeenCalledTimes(0);
  });

  it("Histogram の sum delta を INSERT する", async () => {
    const pool = makeMockPool();

    ragDurationHistogram.labels({ phase: "search", tenantId: "tenant-C" }).observe(500);

    await flushOnce(pool, logger);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const call = pool._queries[0];
    expect(call.values).toContain("rajiuce_rag_duration_ms");
    // sum = 500 が含まれる
    expect(call.values).toContain(500);
  });

  it("pool が null の場合 noop（INSERT しない）", async () => {
    // initMetricsFlush に null を渡す → stop 関数が返る
    const stop = initMetricsFlush(null, logger);
    // エラーなく呼べる
    expect(() => stop()).not.toThrow();
  });

  it("Counter / Histogram に何も記録がない場合 INSERT しない", async () => {
    const pool = makeMockPool();
    await flushOnce(pool, logger);
    expect(pool.query).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: initMetricsFlush (stop 関数 = clearInterval)
// ---------------------------------------------------------------------------

describe("initMetricsFlush", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    conversationTerminalCounter.reset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("stop 関数を呼ぶとタイマーが止まりそれ以降 INSERT しない", async () => {
    const pool = makeMockPool();

    const stop = initMetricsFlush(pool, logger, 1000);

    // 増分を仕込む
    conversationTerminalCounter.labels({ reason: "completed", tenantId: "t1" }).inc(1);

    // 1000ms 進める → flush 1回
    await jest.advanceTimersByTimeAsync(1000);
    const firstCount = (pool.query as jest.Mock).mock.calls.length;

    // stop してから 1000ms 進める → flush しない
    stop();
    await jest.advanceTimersByTimeAsync(1000);
    const secondCount = (pool.query as jest.Mock).mock.calls.length;

    expect(secondCount).toBe(firstCount);
  });
});
