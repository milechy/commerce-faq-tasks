import {
  appendToSessionHistory,
  evictExpiredSessionHistories,
  getSessionHistory,
  sessionHistoryCount,
} from "./contextStore";

describe("contextStore", () => {
  it("同一sessionIdでも別tenantの履歴は取得できない", () => {
    appendToSessionHistory("tenant-a", "session-1", [
      { role: "user", content: "tenant-a の発話" },
    ]);

    expect(getSessionHistory("tenant-a", "session-1")).toEqual([
      { role: "user", content: "tenant-a の発話" },
    ]);
    expect(getSessionHistory("tenant-b", "session-1")).toEqual([]);
  });

  it("同一sessionIdでも別tenantへの追記が互いの履歴を汚染しない", () => {
    appendToSessionHistory("tenant-c", "session-2", [
      { role: "user", content: "tenant-c の発話" },
    ]);
    appendToSessionHistory("tenant-d", "session-2", [
      { role: "user", content: "tenant-d の発話" },
    ]);

    expect(getSessionHistory("tenant-c", "session-2")).toEqual([
      { role: "user", content: "tenant-c の発話" },
    ]);
    expect(getSessionHistory("tenant-d", "session-2")).toEqual([
      { role: "user", content: "tenant-d の発話" },
    ]);
  });

  it("存在しないsession/tenantの組み合わせは空配列を返す", () => {
    expect(getSessionHistory("tenant-unknown", "session-unknown")).toEqual([]);
  });

  it("tenantIdが空文字列でも他テナントの履歴と混ざらない", () => {
    appendToSessionHistory("", "session-empty-tenant", [
      { role: "user", content: "空tenantIdの発話" },
    ]);
    appendToSessionHistory("tenant-e", "session-empty-tenant", [
      { role: "user", content: "tenant-e の発話" },
    ]);

    expect(getSessionHistory("", "session-empty-tenant")).toEqual([
      { role: "user", content: "空tenantIdの発話" },
    ]);
    expect(getSessionHistory("tenant-e", "session-empty-tenant")).toEqual([
      { role: "user", content: "tenant-e の発話" },
    ]);
  });

  it("上限到達（MAX_HISTORY_LENGTH=20件）はテナント単位で独立している", () => {
    const twentyMessages = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `tenant-full の発話${i}`,
    }));
    appendToSessionHistory("tenant-full", "session-limit", twentyMessages);
    // tenant-full は上限ちょうど20件
    expect(getSessionHistory("tenant-full", "session-limit")).toHaveLength(20);

    // 別テナントが同じsessionIdへ1件だけ追記しても、tenant-full 側の20件は変化しない
    appendToSessionHistory("tenant-other", "session-limit", [
      { role: "user", content: "tenant-other の発話" },
    ]);
    expect(getSessionHistory("tenant-full", "session-limit")).toHaveLength(20);
    expect(getSessionHistory("tenant-other", "session-limit")).toHaveLength(1);

    // tenant-full がさらに追記すると古い方から切り詰められる（先頭が押し出される）
    appendToSessionHistory("tenant-full", "session-limit", [
      { role: "user", content: "tenant-full の21件目" },
    ]);
    const trimmed = getSessionHistory("tenant-full", "session-limit");
    expect(trimmed).toHaveLength(20);
    expect(trimmed[0].content).toBe("tenant-full の発話1"); // 発話0 が押し出された
    expect(trimmed[19].content).toBe("tenant-full の21件目");
  });

  it("空配列でappendしても既存履歴を壊さず、Mapに空エントリとして残る（no-opではなくキーが作成される）", () => {
    appendToSessionHistory("tenant-empty-append", "session-1", []);
    // 空配列でも一度appendすればMapにキーは作られる（undefinedとの違いを保証）
    expect(getSessionHistory("tenant-empty-append", "session-1")).toEqual([]);

    appendToSessionHistory("tenant-empty-append", "session-1", [
      { role: "user", content: "後続の発話" },
    ]);
    expect(getSessionHistory("tenant-empty-append", "session-1")).toEqual([
      { role: "user", content: "後続の発話" },
    ]);
  });

  it("極端に長いtenantId/sessionIdでもクラッシュせずキー生成できる", () => {
    const longTenant = "t-" + "a".repeat(2000);
    const longSession = "s-" + "b".repeat(2000);
    expect(() =>
      appendToSessionHistory(longTenant, longSession, [
        { role: "user", content: "long key test" },
      ])
    ).not.toThrow();
    expect(getSessionHistory(longTenant, longSession)).toHaveLength(1);
  });

  describe("キー連結（`${tenantId}::${sessionId}`）のセパレータ衝突防止", () => {
    it("【修正確認】tenantIdに区切り文字`::`が含まれる場合は例外を投げ、衝突を未然に防ぐ", () => {
      // tenantId は作成時バリデーション(/^[a-z0-9_-]+$/)によりコロンを含まない
      // 前提だが、将来その前提が崩れて "A::B" のような tenantId が渡された場合、
      // sessionId="C" との組み合わせが tenantId="A", sessionId="B::C" と
      // 同一内部キーに衝突しうる。サイレントな履歴混在よりも早期失敗を優先する。
      expect(() => appendToSessionHistory("A::B", "C", [
        { role: "user", content: "should not be stored" },
      ])).toThrow(/tenantId must not contain/);
      expect(() => getSessionHistory("A::B", "C")).toThrow(/tenantId must not contain/);
    });

    it("sessionIdに区切り文字`::`が含まれてもtenantIdがコロンを含まなければ衝突しない（最初の`::`が境界として一意に定まるため）", () => {
      // tenantId="A", sessionId="B::C" は内部キー "A::B::C" になるが、
      // tenantId は常にコロン不含のため、他のどの正当な(tenantId, sessionId)の
      // 組み合わせもこのキーとは衝突しない。
      appendToSessionHistory("A", "B::C", [
        { role: "user", content: "tenant=A, session=B::C の発話" },
      ]);
      appendToSessionHistory("A", "other-session", [
        { role: "user", content: "tenant=A, session=other-session の発話" },
      ]);

      expect(getSessionHistory("A", "B::C")).toEqual([
        { role: "user", content: "tenant=A, session=B::C の発話" },
      ]);
      expect(getSessionHistory("A", "other-session")).toEqual([
        { role: "user", content: "tenant=A, session=other-session の発話" },
      ]);
    });
  });
});

describe("contextStore — TTLによるエントリ掃き出し", () => {
  const TTL_MS = 30 * 60 * 1000;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("最終アクセスからTTLを超過したエントリは掃き出される", () => {
    const t0 = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(t0);

    appendToSessionHistory("tenant-ttl-expire", "s1", [
      { role: "user", content: "古い発話" },
    ]);
    expect(getSessionHistory("tenant-ttl-expire", "s1")).toHaveLength(1);
    expect(sessionHistoryCount()).toBeGreaterThanOrEqual(1);

    nowSpy.mockReturnValue(t0 + TTL_MS + 1);
    expect(evictExpiredSessionHistories()).toBeGreaterThanOrEqual(1);
    expect(getSessionHistory("tenant-ttl-expire", "s1")).toEqual([]);
  });

  it("TTLちょうどでは掃き出さない（超過して初めて削除される境界）", () => {
    const t0 = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(t0);

    appendToSessionHistory("tenant-ttl-boundary", "s1", [
      { role: "user", content: "境界値の発話" },
    ]);

    nowSpy.mockReturnValue(t0 + TTL_MS); // ちょうど TTL（> ではないので残る）
    evictExpiredSessionHistories();
    expect(getSessionHistory("tenant-ttl-boundary", "s1")).toHaveLength(1);
  });

  it("【最重要】読み取りでも最終アクセス時刻が更新され、継続中の会話は掃き出されない", () => {
    // これが壊れると「会話中のユーザーの履歴がTTLで突然消える」= 修正の目的を裏切る。
    const t0 = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(t0);

    appendToSessionHistory("tenant-ttl-alive", "s1", [
      { role: "user", content: "継続中の発話" },
    ]);

    // TTLの9割時点で「読み取りだけ」行う（ユーザーが会話を続けている状況）
    nowSpy.mockReturnValue(t0 + TTL_MS * 0.9);
    expect(getSessionHistory("tenant-ttl-alive", "s1")).toHaveLength(1);

    // 最初の書き込みからは TTL を超過しているが、直近の読み取りからは超過していない
    nowSpy.mockReturnValue(t0 + TTL_MS * 0.9 * 2);
    evictExpiredSessionHistories();

    expect(getSessionHistory("tenant-ttl-alive", "s1")).toEqual([
      { role: "user", content: "継続中の発話" },
    ]);
  });

  it("定期スイープの setInterval は unref されている（プロセス終了/jestをブロックしない）", () => {
    jest.resetModules();
    const unref = jest.fn();
    const setIntervalSpy = jest
      .spyOn(global, "setInterval")
      .mockReturnValue({ unref } as unknown as NodeJS.Timeout);

    jest.isolateModules(() => {
      require("./contextStore");
    });

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), TTL_MS);
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
