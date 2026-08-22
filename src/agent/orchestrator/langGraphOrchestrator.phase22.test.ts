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

describe("flowContextStore — TTLによるエントリ掃き出し", () => {
  const TTL_MS = 30 * 60 * 1000;
  // flow セッションもインメモリMapで単調増加する（resetFlowSessionMeta の本番呼び出し元は
  // 存在せず、TTLスイープが実質唯一の回収経路）。contextStore と同じ作法で揃える。
  const {
    getOrInitFlowSessionMeta,
    setFlowSessionMeta,
    peekFlowSessionMeta,
    snapshotFlowSessionMetas,
    evictExpiredFlowSessionMetas,
    flowSessionMetaCount,
  } = require("../dialog/flowContextStore");

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("最終アクセスからTTLを超過したエントリは掃き出される", () => {
    const t0 = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(t0);
    const key = { tenantId: "t-flow-expire", conversationId: "c1" };

    getOrInitFlowSessionMeta(key);
    expect(peekFlowSessionMeta(key)).toBeDefined();
    expect(flowSessionMetaCount()).toBeGreaterThanOrEqual(1);

    nowSpy.mockReturnValue(t0 + TTL_MS + 1);
    expect(evictExpiredFlowSessionMetas()).toBeGreaterThanOrEqual(1);
    expect(peekFlowSessionMeta(key)).toBeUndefined();
  });

  it("【最重要】毎ターンの getOrInitFlowSessionMeta が生存signalになり、継続中のフローは掃き出されない", () => {
    const t0 = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(t0);
    const key = { tenantId: "t-flow-alive", conversationId: "c1" };

    getOrInitFlowSessionMeta(key);

    // TTLの9割時点で次のターンが来る（langGraphOrchestrator は毎ターンこれを呼ぶ）
    nowSpy.mockReturnValue(t0 + TTL_MS * 0.9);
    expect(getOrInitFlowSessionMeta(key)).toBeDefined();

    // 初回作成からはTTL超過だが、直近のターンからは超過していない
    nowSpy.mockReturnValue(t0 + TTL_MS * 0.9 * 2);
    evictExpiredFlowSessionMetas();
    expect(peekFlowSessionMeta(key)).toBeDefined();
  });

  it("snapshotFlowSessionMetas は最終アクセス時刻を更新しない（全件を永久に延命させない）", () => {
    // heartbeat は30分ごとに全件を走査する。ここで延命してしまうと
    // TTLが実質無効化され、修正の意味が消える。
    const t0 = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(t0);
    const key = { tenantId: "t-flow-snapshot", conversationId: "c1" };

    getOrInitFlowSessionMeta(key);

    // TTLの9割時点で heartbeat 相当の全件スナップショットを取る
    nowSpy.mockReturnValue(t0 + TTL_MS * 0.9);
    snapshotFlowSessionMetas();

    // スナップショットは生存signalではないので、初回作成からTTL超過で掃き出される
    nowSpy.mockReturnValue(t0 + TTL_MS + 1);
    evictExpiredFlowSessionMetas();
    expect(peekFlowSessionMeta(key)).toBeUndefined();
  });

  it("公開型 FlowSessionMeta に内部のTTL用フィールドが漏れていない", () => {
    const key = { tenantId: "t-flow-shape", conversationId: "c1" };
    const meta = getOrInitFlowSessionMeta(key);
    expect(Object.keys(meta)).not.toContain("lastAccessedAt");
    expect(snapshotFlowSessionMetas().every((m: Record<string, unknown>) =>
      !Object.prototype.hasOwnProperty.call(m, "lastAccessedAt")
    )).toBe(true);
    setFlowSessionMeta(key, { ...meta, state: "terminal" });
    expect(peekFlowSessionMeta(key)?.state).toBe("terminal");
  });

  it("定期スイープの setInterval は unref されている", () => {
    jest.resetModules();
    const unref = jest.fn();
    const setIntervalSpy = jest
      .spyOn(global, "setInterval")
      .mockReturnValue({ unref } as unknown as NodeJS.Timeout);

    jest.isolateModules(() => {
      require("../dialog/flowContextStore");
    });

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), TTL_MS);
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
