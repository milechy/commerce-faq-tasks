import {
  clearAllSalesSessionMeta,
  clearSalesSessionMeta,
  evictExpiredSalesSessionMetas,
  getSalesSessionMeta,
  salesSessionMetaCount,
  setSalesSessionMeta,
  updateSalesSessionMeta,
  type SalesSessionKey,
} from "./salesContextStore";
import { appendToSessionHistory, getSessionHistory } from "./contextStore";

describe("salesContextStore", () => {
  const key: SalesSessionKey = {
    tenantId: "tenant:demo",
    sessionId: "session:001",
  };

  beforeEach(() => {
    clearAllSalesSessionMeta();
  });

  it("初期状態ではメタが存在しない", () => {
    const meta = getSalesSessionMeta(key);
    expect(meta).toBeUndefined();
  });

  it("setSalesSessionMeta で保存したメタを getSalesSessionMeta で取得できる", () => {
    const saved = setSalesSessionMeta(key, {
      currentStage: "propose" as any,
      lastIntent: "trial_lesson_offer",
      personaTags: ["beginner"],
    });

    const loaded = getSalesSessionMeta(key);
    expect(loaded).toEqual(saved);
    expect(typeof saved.lastUpdatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(saved.lastUpdatedAt))).toBe(false);
  });

  it("updateSalesSessionMeta で部分更新でき、lastUpdatedAt が更新される", () => {
    const initial = setSalesSessionMeta(key, {
      currentStage: "propose" as any,
      lastIntent: "trial_lesson_offer",
      personaTags: ["beginner"],
    });

    const updated = updateSalesSessionMeta(key, {
      lastIntent: "recommend_course_based_on_level",
    });

    expect(updated.currentStage).toBe(initial.currentStage);
    expect(updated.lastIntent).toBe("recommend_course_based_on_level");
    expect(updated.personaTags).toEqual(initial.personaTags);

    const initialMs = Date.parse(initial.lastUpdatedAt);
    const updatedMs = Date.parse(updated.lastUpdatedAt);
    expect(Number.isNaN(initialMs)).toBe(false);
    expect(Number.isNaN(updatedMs)).toBe(false);
    expect(updatedMs).toBeGreaterThanOrEqual(initialMs);
  });

  it("updateSalesSessionMeta は既存メタがない場合に新規作成する", () => {
    const updated = updateSalesSessionMeta(key, {
      currentStage: "clarify" as any,
      lastIntent: "trial_lesson_offer",
    });

    const loaded = getSalesSessionMeta(key);
    expect(loaded).toEqual(updated);
  });

  it("clearSalesSessionMeta / clearAllSalesSessionMeta でメタを削除できる", () => {
    setSalesSessionMeta(key, {
      currentStage: "propose" as any,
      lastIntent: "trial_lesson_offer",
      personaTags: ["beginner"],
    });

    clearSalesSessionMeta(key);
    expect(getSalesSessionMeta(key)).toBeUndefined();

    const anotherKey: SalesSessionKey = {
      tenantId: "tenant:demo",
      sessionId: "session:002",
    };

    setSalesSessionMeta(key, {
      currentStage: "propose" as any,
      lastIntent: "trial_lesson_offer",
    });
    setSalesSessionMeta(anotherKey, {
      currentStage: "recommend" as any,
      lastIntent: "recommend_course_based_on_level",
    });

    clearAllSalesSessionMeta();
    expect(getSalesSessionMeta(key)).toBeUndefined();
    expect(getSalesSessionMeta(anotherKey)).toBeUndefined();
  });

  describe("キー生成はsessionKey.tsのbuildTenantSessionKeyに一本化されている（contextStore.tsとの重複解消）", () => {
    it("【回帰】tenantIdに区切り文字`::`が含まれる場合は例外を投げ、衝突を未然に防ぐ（contextStore.tsと同じ挙動）", () => {
      const badKey: SalesSessionKey = { tenantId: "A::B", sessionId: "C" };
      expect(() =>
        setSalesSessionMeta(badKey, { currentStage: "clarify" as any })
      ).toThrow(/tenantId must not contain/);
      expect(() => getSalesSessionMeta(badKey)).toThrow(/tenantId must not contain/);
    });

    it("通常のtenantId（単一コロン混在含む）は従来どおり動作する", () => {
      // 既存フィクスチャの "tenant:demo" は単一コロンで "::" ではないため許可される
      const normalKey: SalesSessionKey = { tenantId: "tenant:demo", sessionId: "s1" };
      expect(getSalesSessionMeta(normalKey)).toBeUndefined();
      const saved = setSalesSessionMeta(normalKey, { currentStage: "clarify" as any });
      expect(saved.currentStage).toBe("clarify");
    });

    it("同一の内部キー文字列でも、contextStore(会話履歴)とsalesContextStore(商談ステージ)は別Mapのため互いを汚染しない", () => {
      // 両ストアは buildTenantSessionKey で同じキー生成規則を共有するが、
      // Map実体（sessions / sessionStore）は完全に別モジュールスコープ。
      // 同一tenantId+sessionIdの組でも一方の書き込みが他方に漏れないことを確認する。
      const sharedTenant = "tenant-cross-store";
      const sharedSession = "session-cross-store";

      appendToSessionHistory(sharedTenant, sharedSession, [
        { role: "user", content: "会話履歴側の発話" },
      ]);
      setSalesSessionMeta(
        { tenantId: sharedTenant, sessionId: sharedSession },
        { currentStage: "propose" as any, lastIntent: "trial_lesson_offer" }
      );

      expect(getSessionHistory(sharedTenant, sharedSession)).toEqual([
        { role: "user", content: "会話履歴側の発話" },
      ]);
      const salesMeta = getSalesSessionMeta({
        tenantId: sharedTenant,
        sessionId: sharedSession,
      });
      expect(salesMeta?.currentStage).toBe("propose");

      // salesContextStoreをクリアしても会話履歴側は影響を受けない
      clearSalesSessionMeta({ tenantId: sharedTenant, sessionId: sharedSession });
      expect(getSalesSessionMeta({ tenantId: sharedTenant, sessionId: sharedSession })).toBeUndefined();
      expect(getSessionHistory(sharedTenant, sharedSession)).toEqual([
        { role: "user", content: "会話履歴側の発話" },
      ]);
    });
  });
});

describe("salesContextStore — TTLによるエントリ掃き出し", () => {
  const TTL_MS = 30 * 60 * 1000;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("最終アクセスからTTLを超過したエントリは掃き出される", () => {
    const t0 = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(t0);
    const k: SalesSessionKey = { tenantId: "t-ttl-expire", sessionId: "s1" };

    setSalesSessionMeta(k, { currentStage: "propose" as any });
    expect(getSalesSessionMeta(k)).toBeDefined();
    expect(salesSessionMetaCount()).toBeGreaterThanOrEqual(1);

    nowSpy.mockReturnValue(t0 + TTL_MS + 1);
    expect(evictExpiredSalesSessionMetas()).toBeGreaterThanOrEqual(1);
    expect(getSalesSessionMeta(k)).toBeUndefined();
  });

  it("【最重要】読み取りでも最終アクセス時刻が更新され、継続中の会話は掃き出されない", () => {
    const t0 = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(t0);
    const k: SalesSessionKey = { tenantId: "t-ttl-alive", sessionId: "s1" };

    setSalesSessionMeta(k, { currentStage: "propose" as any });

    // TTLの9割時点で「読み取りだけ」行う
    nowSpy.mockReturnValue(t0 + TTL_MS * 0.9);
    expect(getSalesSessionMeta(k)).toBeDefined();

    // 書き込みからはTTL超過だが、直近の読み取りからは超過していない
    nowSpy.mockReturnValue(t0 + TTL_MS * 0.9 * 2);
    evictExpiredSalesSessionMetas();
    expect(getSalesSessionMeta(k)?.currentStage).toBe("propose");
  });

  it("定期スイープの setInterval は unref されている", () => {
    jest.resetModules();
    const unref = jest.fn();
    const setIntervalSpy = jest
      .spyOn(global, "setInterval")
      .mockReturnValue({ unref } as unknown as NodeJS.Timeout);

    jest.isolateModules(() => {
      require("./salesContextStore");
    });

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), TTL_MS);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("公開型 SalesSessionMeta に内部のTTL用フィールドが漏れていない", () => {
    // lastAccessedAt は内部エントリ側だけが持つ。呼び出し側の toEqual を壊さないこと。
    clearAllSalesSessionMeta();
    const k: SalesSessionKey = { tenantId: "t-shape", sessionId: "s1" };
    const saved = setSalesSessionMeta(k, { currentStage: "propose" as any });
    expect(getSalesSessionMeta(k)).toEqual(saved);
    expect(Object.keys(saved)).not.toContain("lastAccessedAt");
  });
});
