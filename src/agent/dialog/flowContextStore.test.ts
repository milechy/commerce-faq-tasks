// src/agent/dialog/flowContextStore.test.ts
//
// #837 の際は「新規ファイルを作らない」制約のため、このストアのテストが
// sessionKey.test.ts と langGraphOrchestrator.phase22.test.ts に間借りしていた。
// ここに専用ファイルとして集約する（contextStore.test.ts / salesContextStore.test.ts
// と同じ構成）。

import {
  evictExpiredFlowSessionMetas,
  flowSessionMetaCount,
  getOrInitFlowSessionMeta,
  peekFlowSessionMeta,
  resetFlowSessionMeta,
  setFlowSessionMeta,
  snapshotFlowSessionMetas,
} from "./flowContextStore";

describe("キー生成の一本化 — flowContextStore も buildTenantSessionKey を経由する", () => {
  // contextStore / salesContextStore は PR #819 で統一済み。
  // flowContextStore だけが生のテンプレートリテラルのまま取り残されており
  // （CLAUDE.md禁止事項6「同じ関心事を複製したまま片方だけ直す」の再発）、
  // ここで3つ目も同じ不変条件に乗ったことを固定する。
  it("tenantIdに`::`が含まれる場合は例外を投げる", () => {
    const badKey = { tenantId: "A::B", conversationId: "C" };

    expect(() => getOrInitFlowSessionMeta(badKey)).toThrow(
      /tenantId must not contain/
    );
    expect(() => peekFlowSessionMeta(badKey)).toThrow(
      /tenantId must not contain/
    );
    expect(() => resetFlowSessionMeta(badKey)).toThrow(
      /tenantId must not contain/
    );
    expect(() =>
      setFlowSessionMeta(badKey, {
        state: "answer",
        turnIndex: 0,
        sameStateRepeats: 0,
        clarifyRepeats: 0,
        confirmRepeats: 0,
        recentStates: [],
        lastUpdatedAt: new Date().toISOString(),
      })
    ).toThrow(/tenantId must not contain/);
  });

  it("通常のtenantId/conversationIdは従来どおり動作し、テナント間で分離される", () => {
    const a = { tenantId: "tenant-a", conversationId: "shared-conv" };
    const b = { tenantId: "tenant-b", conversationId: "shared-conv" };

    const metaA = getOrInitFlowSessionMeta(a);
    setFlowSessionMeta(a, { ...metaA, state: "confirm", turnIndex: 3 });
    getOrInitFlowSessionMeta(b);

    expect(peekFlowSessionMeta(a)?.state).toBe("confirm");
    expect(peekFlowSessionMeta(a)?.turnIndex).toBe(3);
    // 同一 conversationId でも別テナントの状態は汚染されない
    expect(peekFlowSessionMeta(b)?.state).toBe("answer");
    expect(peekFlowSessionMeta(b)?.turnIndex).toBe(0);
  });
});

describe("flowContextStore — TTLによるエントリ掃き出し", () => {
  const TTL_MS = 30 * 60 * 1000;
  // flow セッションもインメモリMapで単調増加する（resetFlowSessionMeta の本番呼び出し元は
  // 存在せず、TTLスイープが実質唯一の回収経路）。contextStore と同じ作法で揃える。

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
    expect(snapshotFlowSessionMetas().every((m) =>
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
      require("./flowContextStore");
    });

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), TTL_MS);
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
