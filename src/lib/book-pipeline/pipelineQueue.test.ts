// src/lib/book-pipeline/pipelineQueue.test.ts
// Phase70K: DB-backed pipelineQueue テスト

jest.mock("./pipeline");
jest.mock("../logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
}));
jest.mock("../alerts/slackNotifier", () => ({
  sendSlackAlert: jest.fn().mockResolvedValue(undefined),
}));

import { runBookPipeline } from "./pipeline";

interface MockJob {
  id: number;
  book_id: number;
  attempts: number;
  status: string;
  enqueued_at: number;
}

/**
 * in-memory job store で DB 操作をシミュレートするモック。
 * re-enqueue (backoff) したジョブは enqueued_at を未来に設定して
 * 直後のポーリングでは拾われないようにする。
 */
function makeDbMock() {
  const jobs: MockJob[] = [];
  let nextId = 1;

  const db = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      // INSERT INTO book_pipeline_jobs (enqueue)
      if (/INSERT INTO book_pipeline_jobs/i.test(sql)) {
        jobs.push({
          id: nextId++,
          book_id: params[0] as number,
          attempts: 0,
          status: "enqueued",
          enqueued_at: Date.now(),
        });
        return { rows: [] };
      }

      // UPDATE ... RETURNING (processNext がジョブをアトミックにクレーム)
      if (/UPDATE book_pipeline_jobs[\s\S]*RETURNING/i.test(sql)) {
        const now = Date.now();
        const job = jobs.find(
          (j) => j.status === "enqueued" && j.enqueued_at <= now
        );
        if (!job) return { rows: [] };
        job.status = "running";
        job.attempts++;
        return {
          rows: [{ id: job.id, book_id: job.book_id, attempts: job.attempts }],
        };
      }

      // UPDATE done
      if (/SET status = 'done'/i.test(sql)) {
        const job = jobs.find((j) => j.id === (params[0] as number));
        if (job) job.status = "done";
        return { rows: [] };
      }

      // UPDATE failed
      if (/SET status = 'failed'/i.test(sql)) {
        const job = jobs.find((j) => j.id === (params[0] as number));
        if (job) job.status = "failed";
        return { rows: [] };
      }

      // UPDATE re-enqueue (backoff) — enqueued_at を 1h 先に設定して直後は拾われない
      if (/SET status = 'enqueued'.*last_error/is.test(sql)) {
        const job = jobs.find((j) => j.id === (params[0] as number));
        if (job) {
          job.status = "enqueued";
          job.enqueued_at = Date.now() + 3_600_000; // 1h 先
        }
        return { rows: [] };
      }

      return { rows: [] };
    }),
    _jobs: jobs,
  };

  return db as unknown as import("pg").Pool & {
    _jobs: MockJob[];
    query: jest.Mock;
  };
}

async function freshQueue() {
  jest.resetModules();
  jest.mock("./pipeline");
  jest.mock("../logger", () => ({
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
    createLogger: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    })),
  }));
  jest.mock("../alerts/slackNotifier", () => ({
    sendSlackAlert: jest.fn().mockResolvedValue(undefined),
  }));
  const { runBookPipeline: rp } = await import("./pipeline");
  const { pipelineQueue: q } = await import("./pipelineQueue");
  const { logger: logMock } = await import("../logger");
  return {
    q,
    rp: rp as jest.MockedFunction<typeof runBookPipeline>,
    logMock,
  };
}

describe("pipelineQueue (DB-backed)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("1: キューに2つのジョブを入れた場合、順次実行される", async () => {
    const { q, rp } = await freshQueue();
    const db = makeDbMock();
    const order: number[] = [];

    // 1つ目: 20ms 待ってから完了（2つ目が割り込まないことを確認）
    rp.mockImplementationOnce(async (bookId) => {
      order.push(bookId);
      await new Promise<void>((r) => setTimeout(r, 20));
      return { chunkCount: 1, pageCount: 1 };
    });

    // 2つ目: 即完了
    rp.mockImplementationOnce(async (bookId) => {
      order.push(bookId);
      return { chunkCount: 1, pageCount: 1 };
    });

    q.enqueue(1, { db });
    q.enqueue(2, { db });

    // 両方が完了するまで待つ (job1=20ms, job2=即時 → 200ms は十分)
    await new Promise<void>((r) => setTimeout(r, 200));

    expect(order).toEqual([1, 2]);
    expect(rp).toHaveBeenCalledTimes(2);
  });

  test("2: エラーが発生しても次のジョブが処理される", async () => {
    const { q, rp, logMock } = await freshQueue();
    const db = makeDbMock();

    // 1つ目: エラーを投げる (attempts=1 < MAX_RETRIES=3 → backoff再エンキュー)
    rp.mockRejectedValueOnce(new Error("pipeline failed"));

    // 2つ目: 正常完了
    rp.mockResolvedValueOnce({ chunkCount: 2, pageCount: 3 });

    q.enqueue(10, { db });
    q.enqueue(20, { db });

    await new Promise<void>((r) => setTimeout(r, 100));

    // 2つ目も実行されたこと
    expect(rp).toHaveBeenCalledTimes(2);
    expect(rp).toHaveBeenNthCalledWith(1, 10, { db });
    expect(rp).toHaveBeenNthCalledWith(2, 20, { db });

    // エラーログが出たこと（書籍内容は含まれない — Anti-Slop）
    expect(logMock.error as jest.Mock).toHaveBeenCalledWith(
      expect.stringContaining("[pipelineQueue] error book_id=%d attempt=%d:"),
      10,
      1,
      "pipeline failed"
    );
  });
});
