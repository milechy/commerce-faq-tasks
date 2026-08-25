// src/agent/tools/synthesisTool.gapWiring.test.ts
//
// ナレッジ配線是正 P13 (Asana GID 1217811237462903):
// synthesizeAnswer 内の detectGap 呼び出しが
// `_topScore > 0 ? _topScore : undefined` としており、実スコアが
// ちょうど0.0のヒットで topRerankScore が undefined 化けし、
// detectGap 側の low_confidence 判定をすり抜けていた。
// 呼び出し側が正しい値を渡すことを直接検証する
// (detectGap 自体の判定ロジックは gapDetectorTriggers.test.ts でカバー)。

const mockDetectGap = jest.fn().mockResolvedValue({ detected: false, source: null });
jest.mock("../gap/gapDetector", () => ({
  detectGap: (...args: unknown[]) => mockDetectGap(...args),
}));

import { synthesizeAnswer } from "./synthesisTool";
import { groqClient } from "../llm/groqClient";
import { getPool } from "../../lib/db";

jest.mock("../llm/groqClient", () => ({
  groqClient: { call: jest.fn(), callWithUsage: jest.fn() },
}));
jest.mock("../../lib/db", () => ({ getPool: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  process.env["GROQ_API_KEY"] = "test-groq-key";
  delete process.env["GAP_DETECTION_ENABLED"];
  (getPool as jest.Mock).mockReturnValue({ query: jest.fn().mockResolvedValue({ rows: [] }) });
  (groqClient.callWithUsage as jest.Mock).mockResolvedValue({
    content: "回答",
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
});

afterEach(() => {
  delete process.env["GROQ_API_KEY"];
});

async function flushMicrotasks() {
  await new Promise((r) => setImmediate(r));
}

describe("synthesizeAnswer — detectGap への topRerankScore 引き継ぎ", () => {
  it("実スコアがちょうど0.0でも undefined にせずそのまま渡す(是正対象のバグの回帰)", async () => {
    await synthesizeAnswer({
      query: "質問",
      items: [{ id: "faq-1", text: "内容", score: 0.0, source: "es" as const }],
      tenantId: "tenant-1",
    });
    await flushMicrotasks();

    expect(mockDetectGap).toHaveBeenCalledTimes(1);
    const call = mockDetectGap.mock.calls[0]![0];
    expect(call.topRerankScore).toBe(0);
    expect(call.ragResultCount).toBe(1);
  });

  it("正のスコアはそのまま渡る(回帰)", async () => {
    await synthesizeAnswer({
      query: "質問",
      items: [{ id: "faq-1", text: "内容", score: 0.75, source: "es" as const }],
      tenantId: "tenant-1",
    });
    await flushMicrotasks();

    const call = mockDetectGap.mock.calls[0]![0];
    expect(call.topRerankScore).toBe(0.75);
  });

  it("ヒット0件のときは topRerankScore=0・ragResultCount=0 で渡る", async () => {
    await synthesizeAnswer({
      query: "質問",
      items: [],
      tenantId: "tenant-1",
    });
    await flushMicrotasks();

    const call = mockDetectGap.mock.calls[0]![0];
    expect(call.ragResultCount).toBe(0);
    expect(call.topRerankScore).toBe(0);
  });
});
