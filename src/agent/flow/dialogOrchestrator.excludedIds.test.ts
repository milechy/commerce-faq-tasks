// src/agent/flow/dialogOrchestrator.excludedIds.test.ts
//
// Phase69-2 [外1] GID 1218086284362759: runDialogOrchestrator が
// options.excludedIds を runSearchAgent にそのまま橋渡しすることを検証する。
//
// 既存の src/agent/flow/dialogOrchestrator.test.ts は jest.config.cjs の
// testPathIgnorePatterns で明示的に除外された legacy スクリプト形式テスト
// (main() を直接実行する形で、runSearchAgent をモックせず実インフラに依存する)
// のため、そこには足さず新規の jest テストとしてここに置く。

jest.mock("./searchAgent", () => ({
  runSearchAgent: jest.fn(),
}));

import type { DialogMessage, MultiStepQueryPlan } from "../dialog/types";
import { runDialogOrchestrator } from "./dialogOrchestrator";
import { runSearchAgent } from "./searchAgent";

const mockRunSearchAgent = runSearchAgent as jest.MockedFunction<typeof runSearchAgent>;

const searchPlan: MultiStepQueryPlan = {
  steps: [
    {
      id: "step_search_1",
      type: "search",
      query: "送料",
      topK: 3,
    } as any,
  ],
  needsClarification: false,
  clarifyingQuestions: [],
  followupQueries: [],
  confidence: "medium",
  language: "ja",
  raw: {},
} as any;

beforeEach(() => {
  jest.clearAllMocks();
  mockRunSearchAgent.mockResolvedValue({ answer: "ok", steps: [] } as any);
});

describe("runDialogOrchestrator — Phase69-2 [外1] excludedIds 配線", () => {
  const history: DialogMessage[] = [];

  it("options.excludedIds を runSearchAgent にそのまま渡す", async () => {
    await runDialogOrchestrator({
      plan: searchPlan,
      sessionId: "session-excluded",
      tenantId: "tenant-a",
      history,
      options: { topK: 3, debug: false, excludedIds: ["id-1", "id-2"] },
    });

    expect(mockRunSearchAgent).toHaveBeenCalledWith(
      expect.objectContaining({ excludedIds: ["id-1", "id-2"] })
    );
  });

  it("options.excludedIds が無い場合、runSearchAgent には undefined のまま渡る（除外なし）", async () => {
    await runDialogOrchestrator({
      plan: searchPlan,
      sessionId: "session-no-excluded",
      tenantId: "tenant-a",
      history,
      options: { topK: 3, debug: false },
    });

    expect(mockRunSearchAgent).toHaveBeenCalledWith(
      expect.objectContaining({ excludedIds: undefined })
    );
  });

  it("clarify 分岐では runSearchAgent 自体が呼ばれない（除外IDの有無に関係なく検索が走らない）", async () => {
    const clarifyPlan: MultiStepQueryPlan = {
      steps: [{ id: "step_clarify_1", type: "clarify", questions: ["どの商品ですか？"] } as any],
      needsClarification: true,
      clarifyingQuestions: ["どの商品ですか？"],
      followupQueries: [],
      confidence: "medium",
      language: "ja",
      raw: {},
    } as any;

    await runDialogOrchestrator({
      plan: clarifyPlan,
      sessionId: "session-clarify",
      tenantId: "tenant-a",
      history,
      options: { excludedIds: ["id-1"] },
    });

    expect(mockRunSearchAgent).not.toHaveBeenCalled();
  });
});
