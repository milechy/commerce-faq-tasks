import { describe, it, expect, beforeEach } from "vitest";
import { hasShownTuningRuleIntro, markTuningRuleIntroShown } from "./tuningRuleIntro";

// このプロジェクトのvitest環境(happy-dom)は window.localStorage を提供しないため、
// テスト用に最小限のMap実装で補う(chatFirstDefault.test.tsと同じパターン)。
function installFakeLocalStorage() {
  const store = new Map<string, string>();
  const fakeStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
  };
  Object.defineProperty(window, "localStorage", { value: fakeStorage, configurable: true });
}

describe("tuningRuleIntro (P6-1: 新規テナントの指示ルール初回紹介、1回きりフラグ)", () => {
  beforeEach(() => {
    installFakeLocalStorage();
  });

  it("既定(未設定)では未紹介", () => {
    expect(hasShownTuningRuleIntro("tenant-a")).toBe(false);
  });

  it("markTuningRuleIntroShown 後は紹介済みになる", () => {
    markTuningRuleIntroShown("tenant-a");
    expect(hasShownTuningRuleIntro("tenant-a")).toBe(true);
  });

  it("テナント単位で分かれる(片方だけ紹介済みでも他方には影響しない)", () => {
    markTuningRuleIntroShown("tenant-a");
    expect(hasShownTuningRuleIntro("tenant-a")).toBe(true);
    expect(hasShownTuningRuleIntro("tenant-b")).toBe(false);
  });

  it("localStorageが例外を投げても(プライベートブラウズ等)静かにfalseへフォールバックする", () => {
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: () => {
          throw new Error("private mode");
        },
        setItem: () => {
          throw new Error("private mode");
        },
      },
      configurable: true,
    });

    expect(hasShownTuningRuleIntro("tenant-a")).toBe(false);
    expect(() => markTuningRuleIntroShown("tenant-a")).not.toThrow();
  });
});
