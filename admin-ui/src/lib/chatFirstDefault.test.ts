import { describe, it, expect, beforeEach } from "vitest";
import { CHAT_FIRST_DEFAULT_KEY, isChatFirstDefaultEnabled, setChatFirstDefaultEnabled } from "./chatFirstDefault";

// このプロジェクトのvitest環境(happy-dom)は window.localStorage を提供しないため、
// テスト用に最小限のMap実装で補う(本番のブラウザでは標準のlocalStorageが使われる。
// chatFirstDefault.ts 自体はlocalStorage不在時にtry/catchでfalseへ安全側フォールバックする設計)。
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

describe("chatFirstDefault (Phase4: 個人オプトイン、既定OFF)", () => {
  beforeEach(() => {
    installFakeLocalStorage();
  });

  it("既定(未設定)では無効", () => {
    expect(isChatFirstDefaultEnabled()).toBe(false);
  });

  it("setChatFirstDefaultEnabled(true) で有効になる", () => {
    setChatFirstDefaultEnabled(true);
    expect(isChatFirstDefaultEnabled()).toBe(true);
    expect(window.localStorage.getItem(CHAT_FIRST_DEFAULT_KEY)).toBe("true");
  });

  it("setChatFirstDefaultEnabled(false) で無効に戻る(キーが削除される)", () => {
    setChatFirstDefaultEnabled(true);
    setChatFirstDefaultEnabled(false);
    expect(isChatFirstDefaultEnabled()).toBe(false);
    expect(window.localStorage.getItem(CHAT_FIRST_DEFAULT_KEY)).toBeNull();
  });

  it("localStorageに無関係な値が入っていても有効とは判定しない(fail-safe)", () => {
    window.localStorage.setItem(CHAT_FIRST_DEFAULT_KEY, "1");
    expect(isChatFirstDefaultEnabled()).toBe(false);
  });
});
