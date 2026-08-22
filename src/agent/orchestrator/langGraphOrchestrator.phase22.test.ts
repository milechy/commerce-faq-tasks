// src/agent/orchestrator/langGraphOrchestrator.phase22.test.ts

import { readFileSync } from "fs";
import { join } from "path";
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

// flowContextStore のTTL掃き出し検証は ./flowContextStore.test.ts (agent/dialog配下) に
// 集約した。#837 で専用テストファイルが無かったためこのファイルに間借りしていたが、
// ここに移動した。

// evaluateSession は dynamic import + setImmediate の fire-and-forget で呼ばれるため
// supertest/直接呼び出しでは到達しにくい。wiringInvariants.test.ts と同じ手法(ソース構造検査)で、
// tenantId 引数の伝播漏れ(=手動trigger経路だけがテナント検証を通す非対称)を防ぐ。
describe("evaluateSession 呼び出しのテナントID伝播（ソース構造検査）", () => {
  const source = readFileSync(join(__dirname, "langGraphOrchestrator.ts"), "utf-8");

  it("全ての evaluateSession(sid, ...) 呼び出しが tenantId を渡している", () => {
    const bareCalls = source.match(/evaluateSession\(sid\)/g) ?? [];
    expect(bareCalls).toHaveLength(0);

    const calls = source.match(/evaluateSession\(sid,\s*[^)]+\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) {
      expect(call).toMatch(/evaluateSession\(sid,\s*(input\.tenantId|flowKey\.tenantId)\)/);
    }
  });
});

