// src/search/ceEngine.test.ts
import {
  __resetCeEngineForTests,
  getCeEngine,
  type CeEngineStatus,
} from "./ceEngine";

describe("CeEngine (dummy / onnx)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    __resetCeEngineForTests();
    jest.restoreAllMocks();
  });

  it("CE_ENGINE 未設定の場合は dummy エンジンを返し、config はデフォルト値になる", async () => {
    delete process.env.CE_ENGINE;
    delete process.env.CE_CANDIDATES;
    delete process.env.CE_MIN_QUERY_CHARS;
    delete process.env.CE_MAX_BATCH_SIZE;

    const engine = getCeEngine();
    expect(engine.name).toBe("dummy");

    const status = engine.status();
    expect(status.engine).toBe("dummy");
    expect(status.onnxLoaded).toBe(false);
    expect(status.modelPath).toBeNull();
    expect(status.error).toBeNull();
    expect(status.warmedUp).toBe(false);

    // デフォルト config が正しく入っていること
    expect(status.config.candidates).toBeGreaterThan(0);
    expect(status.config.minQueryChars).toBeGreaterThan(0);
    expect(status.config.maxBatchSize).toBeGreaterThan(0);

    const scores = await engine.scoreBatch("hello", ["a", "b"]);
    expect(scores).toHaveLength(2);
    expect(scores.every((s) => typeof s === "number")).toBe(true);
  });

  it("環境変数の設定を dummy エンジンの config に反映する", () => {
    process.env.CE_ENGINE = "dummy";
    process.env.CE_CANDIDATES = "10";
    process.env.CE_MIN_QUERY_CHARS = "5";
    process.env.CE_MAX_BATCH_SIZE = "32";

    const engine = getCeEngine();
    const status = engine.status();

    expect(status.engine).toBe("dummy");
    expect(status.config.candidates).toBe(10);
    expect(status.config.minQueryChars).toBe(5);
    expect(status.config.maxBatchSize).toBe(32);
  });

  it("CE_ENGINE=onnx の場合、エンジン名と modelPath が反映される", () => {
    process.env.CE_ENGINE = "onnx";
    process.env.CE_MODEL_PATH = "/models/fake.onnx";

    const engine = getCeEngine();
    const status: CeEngineStatus = engine.status();

    expect(engine.name).toBe("onnx");
    expect(status.engine).toBe("onnx");
    expect(status.modelPath).toBe("/models/fake.onnx");
    // warmup 前なので onnxLoaded は false のはず
    expect(status.onnxLoaded).toBe(false);
  });

  it("onnx エンジンで CE_MODEL_PATH が未設定のとき、warmup はエラー状態を返す", async () => {
    process.env.CE_ENGINE = "onnx";
    delete process.env.CE_MODEL_PATH;

    const engine = getCeEngine();
    const statusBefore = engine.status();
    expect(statusBefore.engine).toBe("onnx");
    expect(statusBefore.modelPath).toBeNull();

    const statusAfter = await engine.warmup();
    expect(statusAfter.engine).toBe("onnx");
    expect(statusAfter.onnxLoaded).toBe(false);
    expect(statusAfter.error).toBe("CE_MODEL_PATH is not set");
  });
});
