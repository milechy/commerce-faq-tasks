// src/lib/magnific.test.ts

import { upscaleWithMagnific } from "./magnific";

const mockFetch = jest.fn();
global.fetch = mockFetch;

const FAKE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("upscaleWithMagnific", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    process.env.FREEPIK_API_KEY = "test-freepik-key";
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.FREEPIK_API_KEY;
  });

  it("FREEPIK_API_KEY 未設定の場合は null を返す", async () => {
    delete process.env.FREEPIK_API_KEY;
    const result = await upscaleWithMagnific({ imageBase64: FAKE_BASE64 });
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("正常系: タスク作成 → ポーリング → base64返却", async () => {
    // createTask
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { task_id: "task-abc123" } }),
      })
      // pollTask: 1回目 processing
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { status: "processing" } }),
      })
      // pollTask: 2回目 done
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            status: "done",
            generated: [{ base64: FAKE_BASE64 }],
          },
        }),
      });

    const promise = upscaleWithMagnific({ imageBase64: FAKE_BASE64 });

    // タイマーを進めてポーリング間隔を消化
    await jest.runAllTimersAsync();

    const result = await promise;
    expect(result).not.toBeNull();
    expect(result!.taskId).toBe("task-abc123");
    expect(result!.imageBase64).toBe(FAKE_BASE64);
  });

  it("タスク失敗時にエラーをスロー", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { task_id: "task-fail" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { status: "failed" } }),
      });

    // statusが"failed"の場合はsetTimeoutに到達しないため直接await
    await expect(upscaleWithMagnific({ imageBase64: FAKE_BASE64 })).rejects.toThrow(
      "Magnific task failed"
    );
  });

  it("createTask APIエラー時にエラーをスロー", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });

    await expect(
      upscaleWithMagnific({ imageBase64: FAKE_BASE64 })
    ).rejects.toThrow("Magnific create task failed (401)");
  });

  it("data:image/jpeg;base64,... プレフィックスを除去してリクエストする", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { task_id: "task-strip" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: { status: "done", generated: [{ base64: FAKE_BASE64 }] },
        }),
      });

    const withPrefix = `data:image/jpeg;base64,${FAKE_BASE64}`;
    const promise = upscaleWithMagnific({ imageBase64: withPrefix });
    await jest.runAllTimersAsync();
    await promise;

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(requestBody.image).toBe(FAKE_BASE64); // プレフィックスなし
    expect(requestBody.image).not.toContain("data:");
  });
});
