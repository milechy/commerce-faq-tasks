// src/agent/judge/judgeSweepRunner.test.ts
// GID 1216970103691946 (PR-12): 離脱セッション自動評価スイープの実行本体テスト。
// 受け入れ条件: 二重評価しない/上限到達がサイレントでない/多重起動しない・
// tickが重ならない/Judge失敗が会話応答に影響しない、を固定する。

const mockQuery = jest.fn();
jest.mock("../../lib/db", () => ({
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
}));

const mockEvaluateSession = jest.fn();
jest.mock("./judgeEvaluator", () => {
  const actual = jest.requireActual("./judgeEvaluator");
  return {
    ...actual,
    evaluateSession: (...args: unknown[]) => mockEvaluateSession(...args),
  };
});

import { judgeSweepRunner } from "./judgeSweepRunner";
import {
  SessionNotFoundError,
  SessionTenantMismatchError,
  SessionTooShortError,
  SessionAlreadyEvaluatedError,
} from "./judgeEvaluator";

function makeCandidates(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    tenant_id: "r2c_default",
    session_id: `session-${i}`,
  }));
}

beforeEach(() => {
  mockQuery.mockReset();
  mockEvaluateSession.mockReset();
  delete process.env.JUDGE_SWEEP_TENANTS;
  judgeSweepRunner.stop();
});

afterEach(() => {
  judgeSweepRunner.stop();
});

describe("judgeSweepRunner.tick", () => {
  it("候補ごとに evaluateSession(sessionId, tenantId) を呼ぶ(expectedTenantIdを必ず渡す)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: makeCandidates(2) });
    mockEvaluateSession.mockResolvedValue({} as any);

    const result = await judgeSweepRunner.tick();

    expect(mockEvaluateSession).toHaveBeenCalledTimes(2);
    expect(mockEvaluateSession).toHaveBeenCalledWith("session-0", "r2c_default");
    expect(mockEvaluateSession).toHaveBeenCalledWith("session-1", "r2c_default");
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
  });

  it.each([
    ["SessionNotFoundError", new SessionNotFoundError("s1")],
    ["SessionTenantMismatchError", new SessionTenantMismatchError("s1")],
    ["SessionTooShortError", new SessionTooShortError("s1")],
    ["SessionAlreadyEvaluatedError", new SessionAlreadyEvaluatedError("s1")],
  ])("%s は failed ではなく skipped として数える(障害ではない)", async (_name, error) => {
    mockQuery.mockResolvedValueOnce({ rows: makeCandidates(1) });
    mockEvaluateSession.mockRejectedValueOnce(error);

    const result = await judgeSweepRunner.tick();

    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("未知のエラー(Gemini恒久失敗等)は failed として数え、他の候補の処理は継続する(会話応答に影響しない)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: makeCandidates(3) });
    mockEvaluateSession
      .mockRejectedValueOnce(new Error("gemini quota exceeded"))
      .mockResolvedValueOnce({} as any)
      .mockRejectedValueOnce(new Error("network error"));

    const result = await judgeSweepRunner.tick();

    expect(mockEvaluateSession).toHaveBeenCalledTimes(3); // 1本の失敗で残りが止まらない
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(2);
  });

  it("候補が上限(limit)に達したとき hitLimit:true を返す(サイレント停止禁止)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: makeCandidates(20) });
    mockEvaluateSession.mockResolvedValue({} as any);

    const result = await judgeSweepRunner.tick(20);

    expect(result.hitLimit).toBe(true);
  });

  it("候補が上限未満のとき hitLimit:false を返す", async () => {
    mockQuery.mockResolvedValueOnce({ rows: makeCandidates(3) });
    mockEvaluateSession.mockResolvedValue({} as any);

    const result = await judgeSweepRunner.tick(20);

    expect(result.hitLimit).toBe(false);
  });

  it("候補0件のときevaluateSessionを呼ばない", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await judgeSweepRunner.tick();

    expect(mockEvaluateSession).not.toHaveBeenCalled();
    expect(result.candidates).toBe(0);
  });

  it("前のtickが実行中なら新しいtickは候補クエリすら発行せずスキップする(多重起動防止)", async () => {
    let resolveFirstEvaluate: (() => void) | undefined;
    mockQuery.mockResolvedValue({ rows: makeCandidates(1) });
    mockEvaluateSession.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveFirstEvaluate = resolve; }),
    );

    const firstTick = judgeSweepRunner.tick();
    // 1本目がevaluateSession内で止まっている間に2本目を叩く
    const secondTickResult = await judgeSweepRunner.tick();

    expect(secondTickResult).toEqual({ candidates: 0, succeeded: 0, skipped: 0, failed: 0, hitLimit: false });
    expect(mockQuery).toHaveBeenCalledTimes(1); // 2本目は候補クエリを発行していない

    resolveFirstEvaluate?.();
    await firstTick;
  });

  it("JUDGE_SWEEP_TENANTS未設定時は既定でr2c_defaultのみを対象にする", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await judgeSweepRunner.tick();

    const [, params] = mockQuery.mock.calls[0]!;
    expect((params as unknown[])[0]).toEqual(["r2c_default"]);
  });

  it("JUDGE_SWEEP_TENANTSが設定されていればカンマ区切りで解釈する", async () => {
    process.env.JUDGE_SWEEP_TENANTS = "r2c_default, carnation";
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await judgeSweepRunner.tick();

    const [, params] = mockQuery.mock.calls[0]!;
    expect((params as unknown[])[0]).toEqual(["r2c_default", "carnation"]);
  });
});

describe("judgeSweepRunner.start / stop", () => {
  it("start()を2回呼んでもintervalは1本しか登録されない(二重登録防止)。stop()後は再度start()できる", () => {
    const setIntervalSpy = jest.spyOn(global, "setInterval");
    try {
      judgeSweepRunner.start(1000);
      judgeSweepRunner.start(1000);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);

      judgeSweepRunner.stop();
      judgeSweepRunner.start(1000);
      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });
});
