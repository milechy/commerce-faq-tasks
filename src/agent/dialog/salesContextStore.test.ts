import {
  clearAllSalesSessionMeta,
  clearSalesSessionMeta,
  getSalesSessionMeta,
  setSalesSessionMeta,
  updateSalesSessionMeta,
  type SalesSessionKey,
} from "./salesContextStore";

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
});
