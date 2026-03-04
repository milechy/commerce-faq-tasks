// src/search/rerank.ce.test.ts
import type { CeEngine, CeEngineStatus } from "./ceEngine";
import * as ceEngineModule from "./ceEngine";
import { rerank, type Item } from "./rerank";

describe("rerank with CeEngine", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    // Reset singletons/caches so tests do not leak state via module scope.
    ceEngineModule.__resetCeEngineForTests();
    const rerankModule = require("./rerank") as typeof import("./rerank");
    if (typeof rerankModule.__resetCeForTests === "function") {
      rerankModule.__resetCeForTests();
    }
  });

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

  function makeEngine(
    status: CeEngineStatus,
    scoreImpl?: jest.Mock<
      Promise<number[]>,
      [string, string[], { abortSignal?: AbortSignal }?]
    >
  ): CeEngine {
    const scoreBatchMock =
      scoreImpl ??
      (jest.fn().mockResolvedValue([]) as jest.Mock<
        Promise<number[]>,
        [string, string[], { abortSignal?: AbortSignal }?]
      >);

    return {
      name: status.engine,
      warmup: jest.fn().mockResolvedValue(status),
      status: jest.fn(() => status),
      // 型合わせのために as unknown as を挟む
      scoreBatch: scoreBatchMock as unknown as CeEngine["scoreBatch"],
    };
  }

  const baseItems: Item[] = [
    { id: "1", text: "hello world", score: 1, source: "es" },
    { id: "2", text: "hello", score: 1, source: "es" },
    { id: "3", text: "nothing", score: 1, source: "es" },
  ];

  const query = "hello world"; // 長さ 11 > MIN_QUERY_CHARS(デフォルト8) を満たす

  it("CE エンジンが有効でない場合は heuristic のみでランクされる", async () => {
    const status = makeStatus({
      engine: "dummy",
      onnxLoaded: false,
    });

    const engine = makeEngine(status);
    const spy = jest
      .spyOn(ceEngineModule, "getCeEngine")
      .mockReturnValue(engine);

    const result = await rerank(query, baseItems, 3);

    // CE 未使用なので engine は heuristic のまま
    expect(result.engine).toBe("heuristic");
    // getCeEngine は呼ばれているが…
    expect(spy).toHaveBeenCalled();
    // CE 無効条件なので scoreBatch は呼ばれない
    const scoreBatchMock = engine.scoreBatch as unknown as jest.Mock;
    expect(scoreBatchMock).not.toHaveBeenCalled();

    // heuristic の期待順序: 完全一致 > 部分一致 > ヒットなし
    expect(result.items.map((i) => i.id)).toEqual(["1", "2", "3"]);
  });

  it("onnx エンジンがロード済みなら CE スコアで再ランクされる", async () => {
    const status = makeStatus({
      engine: "onnx",
      onnxLoaded: true,
      error: null,
    });

    // CE に渡された 3 件に対して「2 が一番高い」スコアを返すようにする
    const scoreImpl = jest
      .fn<
        Promise<number[]>,
        [string, string[], { abortSignal?: AbortSignal }?]
      >()
      .mockResolvedValue([
        0, // id:1
        10, // id:2
        -5, // id:3
      ]);

    const engine = makeEngine(status, scoreImpl);
    jest.spyOn(ceEngineModule, "getCeEngine").mockReturnValue(engine);

    const result = await rerank(query, baseItems, 2);

    expect(result.engine).toBe("ce");

    // CE が 1 回呼ばれ、3 件の docs が渡されていること
    expect(scoreImpl).toHaveBeenCalledTimes(1);
    const callArgs = scoreImpl.mock.calls[0];
    expect(callArgs[0]).toBe(query); // query
    expect(callArgs[1]).toHaveLength(3); // docs

    // CE スコアで 2 > 1 > 3 となるので、topK=2 なら [2,1]
    expect(result.items.map((i) => i.id)).toEqual(["2", "1"]);
  });

  it("CE 実行中に例外が発生した場合は heuristic にフォールバックし engine=ce+fallback になる", async () => {
    const status = makeStatus({
      engine: "onnx",
      onnxLoaded: true,
      error: null,
    });

    const scoreImpl = jest
      .fn<
        Promise<number[]>,
        [string, string[], { abortSignal?: AbortSignal }?]
      >()
      .mockRejectedValue(new Error("CE boom"));

    const engine = makeEngine(status, scoreImpl);
    jest.spyOn(ceEngineModule, "getCeEngine").mockReturnValue(engine);

    const result = await rerank(query, baseItems, 3);

    expect(result.engine).toBe("ce+fallback");

    // 失敗しても heuristic Stage1 の結果に戻るので順序は [1,2,3] のまま
    expect(result.items.map((i) => i.id)).toEqual(["1", "2", "3"]);
  });
});
