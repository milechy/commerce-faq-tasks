// src/search/ceApi.test.ts
import type { CeEngine, CeEngineStatus } from "./ceEngine";
import * as ceEngineModule from "./ceEngine";
import { ceStatus, warmupCE } from "./rerank";

function makeStatus(overrides: Partial<CeEngineStatus> = {}): CeEngineStatus {
  return {
    engine: "dummy",
    onnxLoaded: false,
    modelPath: null,
    error: null,
    config: {
      candidates: 24,
      minQueryChars: 8,
      maxBatchSize: 16,
    },
    warmedUp: false,
    ...overrides,
  };
}

function makeEngine(status: CeEngineStatus): CeEngine {
  return {
    name: status.engine,
    warmup: jest.fn().mockResolvedValue(status),
    status: jest.fn(() => status),
    // scoreBatch はこのテストでは使わないので、適当なモックでよい
    scoreBatch: jest.fn().mockResolvedValue([]),
  };
}

describe("warmupCE / ceStatus API wrappers", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("warmupCE: onnx がロード済みなら ok=true, engine=onnx, model が返る", async () => {
    const st = makeStatus({
      engine: "onnx",
      onnxLoaded: true,
      modelPath: "/models/ce.onnx",
      error: null,
      warmedUp: true,
    });

    const engine = makeEngine(st);
    jest.spyOn(ceEngineModule, "getCeEngine").mockReturnValue(engine);

    const res = await warmupCE();

    expect(res.ok).toBe(true);
    expect(res.engine).toBe("onnx");
    expect(res.model).toBe("/models/ce.onnx");
    expect(res.error).toBeUndefined();
  });

  it("warmupCE: onnxLoaded=false または error ありなら ok=false, engine=dummy になる", async () => {
    const st = makeStatus({
      engine: "onnx",
      onnxLoaded: false,
      modelPath: "/models/ce.onnx",
      error: "load failed",
      warmedUp: true,
    });

    const engine = makeEngine(st);
    jest.spyOn(ceEngineModule, "getCeEngine").mockReturnValue(engine);

    const res = await warmupCE();

    expect(res.ok).toBe(false);
    expect(res.engine).toBe("dummy");
    expect(res.model).toBe("/models/ce.onnx");
    expect(res.error).toBe("load failed");
  });

  it("ceStatus: onnx がロード済みでエラーなしなら onnxLoaded=true, engine=onnx, onnxError=null", () => {
    const st = makeStatus({
      engine: "onnx",
      onnxLoaded: true,
      error: null,
    });

    const engine = makeEngine(st);
    jest.spyOn(ceEngineModule, "getCeEngine").mockReturnValue(engine);

    const res = ceStatus();

    expect(res.onnxLoaded).toBe(true);
    expect(res.engine).toBe("onnx");
    expect(res.onnxError).toBeNull();
  });

  it("ceStatus: warmup 前でも engine は設定どおり（例: onnx）で、onnxLoaded=false になりうる", () => {
    const st = makeStatus({
      engine: "onnx",
      onnxLoaded: false,
      error: "something wrong",
    });

    const engine = makeEngine(st);
    jest.spyOn(ceEngineModule, "getCeEngine").mockReturnValue(engine);

    const res = ceStatus();

    expect(res.onnxLoaded).toBe(false);
    expect(res.engine).toBe("onnx");
    // onnxError は status.error 次第（warmup 前だと null のこともある）
    expect(res.onnxError).toBe("something wrong");
  });
});
