// src/lib/book-pipeline/pipelineQueue.test.ts
// Phase47 Stream C: pipelineQueue テスト

jest.mock("./pipeline");
jest.mock("../logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
}));
import { runBookPipeline } from "./pipeline";
import { logger } from "../logger";

const mockRunBookPipeline = runBookPipeline as jest.MockedFunction<typeof runBookPipeline>;

// pipelineQueue はモック後にインポートする必要があるため動的に取得
async function freshQueue() {
  jest.resetModules();
  jest.mock("./pipeline");
  jest.mock("../logger", () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
  }));
  const { runBookPipeline: rp } = await import("./pipeline");
  const { pipelineQueue: q } = await import("./pipelineQueue");
  const { logger: logMock } = await import("../logger");
  return { q, rp: rp as jest.MockedFunction<typeof runBookPipeline>, logMock };
}

const DUMMY_DEPS = { db: {} as any };

describe("pipelineQueue", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("1: キューに2つのジョブを入れた場合、順次実行される", async () => {
    const order: number[] = [];
    let resolveFirst!: () => void;
    const firstStarted = new Promise<void>((res) => {
      resolveFirst = res;
    });

    const { q, rp } = await freshQueue();

    // 1つ目: firstStarted を通知してから完了
    rp.mockImplementationOnce(async (bookId) => {
      order.push(bookId);
      resolveFirst();
      // 少し待つ（2つ目が割り込まないことを確認）
      await new Promise<void>((r) => setTimeout(r, 20));
      return { chunkCount: 1, pageCount: 1 };
    });

    // 2つ目: 即完了
    rp.mockImplementationOnce(async (bookId) => {
      order.push(bookId);
      return { chunkCount: 1, pageCount: 1 };
    });

    q.enqueue(1, DUMMY_DEPS);
    q.enqueue(2, DUMMY_DEPS);

    // 1つ目が開始されるまで待つ
    await firstStarted;

    // 両方が完了するまで待つ
    await new Promise<void>((r) => setTimeout(r, 100));

    expect(order).toEqual([1, 2]);
    expect(rp).toHaveBeenCalledTimes(2);
  });

  test("2: エラーが発生しても次のジョブが処理される", async () => {
    const { q, rp, logMock } = await freshQueue();

    // 1つ目: エラーを投げる
    rp.mockRejectedValueOnce(new Error("pipeline failed"));

    // 2つ目: 正常完了
    rp.mockResolvedValueOnce({ chunkCount: 2, pageCount: 3 });

    q.enqueue(10, DUMMY_DEPS);
    q.enqueue(20, DUMMY_DEPS);

    // 両方が完了するまで待つ
    await new Promise<void>((r) => setTimeout(r, 100));

    // 2つ目も実行されたこと
    expect(rp).toHaveBeenCalledTimes(2);
    expect(rp).toHaveBeenNthCalledWith(1, 10, DUMMY_DEPS);
    expect(rp).toHaveBeenNthCalledWith(2, 20, DUMMY_DEPS);

    // エラーログが出たこと（書籍内容は含まれない）
    expect(logMock.error as jest.Mock).toHaveBeenCalledWith(
      expect.stringContaining("[pipelineQueue] error book_id=%d:"),
      10,
      "pipeline failed"
    );
  });
});
