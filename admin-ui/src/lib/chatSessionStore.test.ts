import { describe, it, expect, beforeEach } from "vitest";
import {
  CHAT_SESSION_SURFACE_FULLSCREEN,
  CHAT_SESSION_SURFACE_PANEL,
  MAX_PERSISTED_MESSAGES,
  chatSessionKey,
  clearChatSession,
  restoreChatSession,
  saveChatSession,
} from "./chatSessionStore";

// chatFirstDefault.test.ts と同じ方針で、テスト用のsessionStorageをMapで差し替える
// (実装側は sessionStorage 不在・例外時に try/catch で安全側へフォールバックする設計)。
function installFakeSessionStorage(): void {
  const store = new Map<string, string>();
  const fakeStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
  };
  Object.defineProperty(window, "sessionStorage", { value: fakeStorage, configurable: true });
}

// プライベートブラウズやクォータ超過で sessionStorage のアクセス自体が throw する環境
function installThrowingSessionStorage(): void {
  const boom = () => {
    throw new Error("QuotaExceededError");
  };
  Object.defineProperty(window, "sessionStorage", {
    value: { getItem: boom, setItem: boom, removeItem: boom, clear: boom },
    configurable: true,
  });
}

interface TestMsg {
  id: number;
  text: string;
}

const SESSION = {
  sessionId: "session-abc",
  messages: [
    { id: 1, text: "送料を教えて" },
    { id: 2, text: "全国一律550円です。" },
  ] as TestMsg[],
  history: [
    { role: "user" as const, content: "送料を教えて" },
    { role: "assistant" as const, content: "全国一律550円です。" },
  ],
};

describe("chatSessionStore (タブ単位の会話永続化)", () => {
  beforeEach(() => {
    installFakeSessionStorage();
  });

  it("保存した会話をそのまま復元できる(往復)", () => {
    saveChatSession(CHAT_SESSION_SURFACE_FULLSCREEN, SESSION);

    expect(restoreChatSession<TestMsg>(CHAT_SESSION_SURFACE_FULLSCREEN)).toEqual(SESSION);
  });

  it("history を持たない面(パネル)は history なしで保存でき、復元時は空配列になる", () => {
    saveChatSession(CHAT_SESSION_SURFACE_PANEL, { sessionId: "s1", messages: SESSION.messages });

    expect(restoreChatSession<TestMsg>(CHAT_SESSION_SURFACE_PANEL)).toEqual({
      sessionId: "s1",
      messages: SESSION.messages,
      history: [],
    });
  });

  it(`上限(${MAX_PERSISTED_MESSAGES}件)を超えたら直近の分だけ保存される`, () => {
    const messages: TestMsg[] = Array.from({ length: MAX_PERSISTED_MESSAGES + 10 }, (_, i) => ({
      id: i,
      text: `msg-${i}`,
    }));
    saveChatSession(CHAT_SESSION_SURFACE_FULLSCREEN, { sessionId: "s1", messages });

    const restored = restoreChatSession<TestMsg>(CHAT_SESSION_SURFACE_FULLSCREEN);
    expect(restored?.messages).toHaveLength(MAX_PERSISTED_MESSAGES);
    expect(restored?.messages[0]).toEqual({ id: 10, text: "msg-10" });
    expect(restored?.messages[MAX_PERSISTED_MESSAGES - 1]).toEqual({
      id: MAX_PERSISTED_MESSAGES + 9,
      text: `msg-${MAX_PERSISTED_MESSAGES + 9}`,
    });
  });

  it("何も保存していなければ null", () => {
    expect(restoreChatSession(CHAT_SESSION_SURFACE_FULLSCREEN)).toBeNull();
  });

  it("壊れたJSONが入っていても throw せず null", () => {
    window.sessionStorage.setItem(chatSessionKey(CHAT_SESSION_SURFACE_FULLSCREEN), "not-json");

    expect(() => restoreChatSession(CHAT_SESSION_SURFACE_FULLSCREEN)).not.toThrow();
    expect(restoreChatSession(CHAT_SESSION_SURFACE_FULLSCREEN)).toBeNull();
  });

  it("形が想定と違う(sessionId欠落/messagesが配列でない)場合も null", () => {
    const key = chatSessionKey(CHAT_SESSION_SURFACE_FULLSCREEN);

    window.sessionStorage.setItem(key, JSON.stringify({ messages: [] }));
    expect(restoreChatSession(CHAT_SESSION_SURFACE_FULLSCREEN)).toBeNull();

    window.sessionStorage.setItem(key, JSON.stringify({ sessionId: "s1", messages: "nope" }));
    expect(restoreChatSession(CHAT_SESSION_SURFACE_FULLSCREEN)).toBeNull();
  });

  it("clearChatSession で消える(その面だけ)", () => {
    saveChatSession(CHAT_SESSION_SURFACE_FULLSCREEN, SESSION);
    saveChatSession(CHAT_SESSION_SURFACE_PANEL, { sessionId: "s2", messages: [{ id: 9, text: "パネル" }] });

    clearChatSession(CHAT_SESSION_SURFACE_FULLSCREEN);

    expect(restoreChatSession(CHAT_SESSION_SURFACE_FULLSCREEN)).toBeNull();
    expect(restoreChatSession<TestMsg>(CHAT_SESSION_SURFACE_PANEL)?.sessionId).toBe("s2");
  });

  it("面ごとにキーが分かれ、互いの会話を上書きしない", () => {
    saveChatSession(CHAT_SESSION_SURFACE_FULLSCREEN, SESSION);
    saveChatSession(CHAT_SESSION_SURFACE_PANEL, {
      sessionId: "session-panel",
      messages: [{ id: 9, text: "パネル側の会話" }] as TestMsg[],
    });

    expect(restoreChatSession<TestMsg>(CHAT_SESSION_SURFACE_FULLSCREEN)).toEqual(SESSION);
    expect(restoreChatSession<TestMsg>(CHAT_SESSION_SURFACE_PANEL)?.messages).toEqual([
      { id: 9, text: "パネル側の会話" },
    ]);
    expect(chatSessionKey(CHAT_SESSION_SURFACE_FULLSCREEN)).not.toBe(chatSessionKey(CHAT_SESSION_SURFACE_PANEL));
  });

  it("sessionStorageが例外を投げる環境でも throw しない(保存/復元/削除)", () => {
    installThrowingSessionStorage();

    expect(() => saveChatSession(CHAT_SESSION_SURFACE_FULLSCREEN, SESSION)).not.toThrow();
    expect(() => restoreChatSession(CHAT_SESSION_SURFACE_FULLSCREEN)).not.toThrow();
    expect(() => clearChatSession(CHAT_SESSION_SURFACE_FULLSCREEN)).not.toThrow();
    expect(restoreChatSession(CHAT_SESSION_SURFACE_FULLSCREEN)).toBeNull();
  });
});
