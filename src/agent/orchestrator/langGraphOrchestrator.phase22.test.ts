// src/agent/orchestrator/langGraphOrchestrator.phase22.test.ts

import { resetFlowSessionMeta } from "../dialog/flowContextStore";
import { runDialogGraph } from "./langGraphOrchestrator";

describe("Phase22 flow control (must reach terminal)", () => {
  const baseInput = {
    tenantId: "t1",
    locale: "ja",
    conversationId: "c1",
    userMessage: "質問です",
  };

  beforeEach(() => {
    process.env.NODE_ENV = "test";
    resetFlowSessionMeta({ tenantId: "t1", conversationId: "c1" });
    process.env.PHASE22_MAX_TURNS = "12";
    process.env.PHASE22_MAX_CONFIRM_REPEATS = "2";
  });

  test("answer -> confirm prompt is appended", async () => {
    const out = await runDialogGraph(baseInput as any);
    expect(out.text).toContain("[test output]");
    expect(out.text).toContain("この内容で会話を終了してよいですか？");
  });

  test("confirm yes -> terminal completed without calling graph", async () => {
    await runDialogGraph(baseInput as any); // move to confirm
    const out2 = await runDialogGraph({
      ...baseInput,
      userMessage: "はい",
    } as any);
    expect(out2.text).toContain("会話を終了します");
    // completed or aborted_user acceptable by copy, but flow should terminal
  });

  test("confirm unknown repeats -> aborted_budget", async () => {
    await runDialogGraph(baseInput as any); // move to confirm
    await runDialogGraph({ ...baseInput, userMessage: "？？" } as any); // 1st unknown
    const out3 = await runDialogGraph({
      ...baseInput,
      userMessage: "わからない",
    } as any); // 2nd unknown -> budget
    expect(out3.text).toContain("安全のため会話を終了");
  });

  test("turn budget exceeded -> terminal", async () => {
    process.env.PHASE22_MAX_TURNS = "1";
    await runDialogGraph(baseInput as any); // turn 1 ok
    const out2 = await runDialogGraph({
      ...baseInput,
      userMessage: "次",
    } as any);
    expect(out2.text).toContain("安全のため会話を終了");
  });
});
