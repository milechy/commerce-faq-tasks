// GID 1217008593800087: チャットUI 2面(パネル/全画面)が独立に手書きしていた transport 層
// (sessionId / 直近履歴ウィンドウ / targetTenantId 導出 / エラー文言)を共有フックに一本化した
// 分の単体テスト。特に targetTenantId の導出は認可に触れる(super_adminのプレビュー対象を
// 決める)ため、ロール・previewMode の組み合わせを明示的に固定する。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  AGENT_CHAT_AUTH_REQUIRED_MESSAGE,
  AGENT_CHAT_ERROR_MESSAGE,
  AGENT_CHAT_HISTORY_MAX_CHARS,
  AGENT_CHAT_HISTORY_MAX_ENTRIES,
  useAgentChatTransport,
} from "./useAgentChatTransport";
import type { ChatHistoryEntry } from "./chatSessionStore";

vi.mock("./api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
}));

vi.mock("../auth/useAuth", () => ({
  useAuth: vi.fn(),
}));

import { authFetch } from "./api";
import { useAuth } from "../auth/useAuth";

const CHAT_URL = "http://localhost:3100/v1/admin/agent/chat";

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) } as Response);

function baseAuth(overrides: Partial<ReturnType<typeof useAuth>> = {}) {
  return {
    user: { id: "1", email: "a@example.com", role: "client_admin", tenantId: "tenant-a", tenantName: "Tenant A" },
    isLoading: false,
    isSuperAdmin: false,
    isClientAdmin: true,
    logout: vi.fn().mockResolvedValue(undefined),
    previewMode: false,
    previewTenantId: null,
    previewTenantName: null,
    enterPreview: vi.fn(),
    exitPreview: vi.fn(),
    tenantPlan: null,
    ...overrides,
  } as ReturnType<typeof useAuth>;
}

function setAuth(overrides: Partial<ReturnType<typeof useAuth>> = {}) {
  vi.mocked(useAuth).mockReturnValue(baseAuth(overrides));
}

/** 最後に送られたリクエストボディを読む */
function lastBody(): Record<string, unknown> {
  const call = vi.mocked(authFetch).mock.calls.at(-1)!;
  return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
}

const entries = (n: number): ChatHistoryEntry[] =>
  Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as ChatHistoryEntry["role"],
    content: `メッセージ${i + 1}`,
  }));

beforeEach(() => {
  vi.mocked(authFetch).mockReset();
  vi.mocked(authFetch).mockImplementation(() => mockOk({ reply: "了解しました。", actions: [] }));
  setAuth();
});

describe("useAgentChatTransport — sessionId", () => {
  it("マウント時に一度だけ発行され、再レンダーを跨いでも変わらない", () => {
    const { result, rerender } = renderHook(() => useAgentChatTransport({ surface: "panel" }));
    const first = result.current.sessionId;

    expect(first).toBeTruthy();
    rerender();
    rerender();
    expect(result.current.sessionId).toBe(first);
  });

  it("送信を跨いでも同じ sessionId を送り続ける(マルチターンがサーバ側で繋がる)", async () => {
    const { result } = renderHook(() => useAgentChatTransport({ surface: "panel" }));
    const sessionId = result.current.sessionId;

    await act(async () => { await result.current.send("1通目"); });
    await act(async () => { await result.current.send("2通目"); });

    const bodies = vi.mocked(authFetch).mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(bodies.map((b) => b.sessionId)).toEqual([sessionId, sessionId]);
  });

  it("initialSessionId を渡すと復元した会話の続きとして始まる(新規発行しない)", () => {
    const { result } = renderHook(() =>
      useAgentChatTransport({ surface: "panel", initialSessionId: "restored-session-id" }),
    );

    expect(result.current.sessionId).toBe("restored-session-id");
  });

  it("adoptSessionId でマウント後に復元した sessionId を引き継ぎ、以降の送信に反映される", async () => {
    const { result } = renderHook(() => useAgentChatTransport({ surface: "fullscreen" }));

    act(() => { result.current.adoptSessionId("adopted-session-id"); });
    expect(result.current.sessionId).toBe("adopted-session-id");

    await act(async () => { await result.current.send("送料を教えて"); });
    expect(lastBody().sessionId).toBe("adopted-session-id");
  });
});

describe("useAgentChatTransport — 直近履歴ウィンドウ", () => {
  it("上限件数までは全件そのまま送る(境界)", async () => {
    const { result } = renderHook(() => useAgentChatTransport({ surface: "panel" }));

    await act(async () => {
      await result.current.send("次の質問", { history: entries(AGENT_CHAT_HISTORY_MAX_ENTRIES) });
    });

    const history = lastBody().history as ChatHistoryEntry[];
    expect(history).toHaveLength(AGENT_CHAT_HISTORY_MAX_ENTRIES);
    expect(history[0].content).toBe("メッセージ1");
  });

  it("上限を超えた分は古い側から捨てる(境界+1)", async () => {
    const { result } = renderHook(() => useAgentChatTransport({ surface: "panel" }));

    await act(async () => {
      await result.current.send("次の質問", { history: entries(AGENT_CHAT_HISTORY_MAX_ENTRIES + 1) });
    });

    const history = lastBody().history as ChatHistoryEntry[];
    expect(history).toHaveLength(AGENT_CHAT_HISTORY_MAX_ENTRIES);
    expect(history[0].content).toBe("メッセージ2");
    expect(history.at(-1)!.content).toBe(`メッセージ${AGENT_CHAT_HISTORY_MAX_ENTRIES + 1}`);
  });

  it("1件あたりの文字数も上限で切る", async () => {
    const { result } = renderHook(() => useAgentChatTransport({ surface: "panel" }));
    const long = "あ".repeat(AGENT_CHAT_HISTORY_MAX_CHARS + 500);

    await act(async () => {
      await result.current.send("次の質問", { history: [{ role: "user", content: long }] });
    });

    const history = lastBody().history as ChatHistoryEntry[];
    expect(history[0].content).toHaveLength(AGENT_CHAT_HISTORY_MAX_CHARS);
  });

  it("空文字・空白だけの履歴は送らず、履歴が0件ならキー自体を省く", async () => {
    const { result } = renderHook(() => useAgentChatTransport({ surface: "panel" }));

    await act(async () => {
      await result.current.send("最初の質問", { history: [{ role: "assistant", content: "  " }] });
    });

    expect(lastBody()).not.toHaveProperty("history");
  });
});

describe("useAgentChatTransport — targetTenantId の導出(認可)", () => {
  it("client_admin では送らない(サーバがJWTの tenant_id を使う)", async () => {
    setAuth();
    const { result } = renderHook(() => useAgentChatTransport({ surface: "panel" }));

    expect(result.current.targetTenantId).toBeUndefined();
    await act(async () => { await result.current.send("送料を教えて"); });
    expect(lastBody()).not.toHaveProperty("targetTenantId");
  });

  it("super_admin がプレビュー中なら previewTenantId を送る", async () => {
    setAuth({
      isSuperAdmin: false, // previewMode 中は useAuth の実効ロールが client_admin になる
      isClientAdmin: true,
      previewMode: true,
      previewTenantId: "tenant-preview",
      previewTenantName: "Preview Tenant",
      user: { id: "2", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null },
    });
    const { result } = renderHook(() => useAgentChatTransport({ surface: "panel" }));

    expect(result.current.targetTenantId).toBe("tenant-preview");
    await act(async () => { await result.current.send("送料を教えて"); });
    expect(lastBody().targetTenantId).toBe("tenant-preview");
  });

  it("super_admin がプレビュー外(テナント未選択)なら送らない", async () => {
    setAuth({
      isSuperAdmin: true,
      isClientAdmin: false,
      previewMode: false,
      previewTenantId: null,
      user: { id: "2", email: "admin@example.com", role: "super_admin", tenantId: null, tenantName: null },
    });
    const { result } = renderHook(() => useAgentChatTransport({ surface: "panel" }));

    expect(result.current.targetTenantId).toBeUndefined();
    await act(async () => { await result.current.send("送料を教えて"); });
    expect(lastBody()).not.toHaveProperty("targetTenantId");
  });

  it("previewMode でも previewTenantId が無ければ送らない", async () => {
    setAuth({ previewMode: true, previewTenantId: null });
    const { result } = renderHook(() => useAgentChatTransport({ surface: "panel" }));

    expect(result.current.targetTenantId).toBeUndefined();
    await act(async () => { await result.current.send("送料を教えて"); });
    expect(lastBody()).not.toHaveProperty("targetTenantId");
  });

  it("呼び出し側の明示指定は導出結果より優先される(パネルの既存API互換の経路)", async () => {
    setAuth();
    const { result } = renderHook(() => useAgentChatTransport({ surface: "panel" }));

    await act(async () => { await result.current.send("送料を教えて", { targetTenantId: "tenant-explicit" }); });
    expect(lastBody().targetTenantId).toBe("tenant-explicit");
  });
});

describe("useAgentChatTransport — エラーの正規化", () => {
  it("fetch が失敗したら共通の文言で ok:false を返す(例外は投げない)", async () => {
    vi.mocked(authFetch).mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useAgentChatTransport({ surface: "panel" }));

    let outcome!: Awaited<ReturnType<typeof result.current.send>>;
    await act(async () => { outcome = await result.current.send("送料を教えて"); });

    expect(outcome).toEqual({ ok: false, kind: "network", message: AGENT_CHAT_ERROR_MESSAGE });
    // 技術的な内容(例外メッセージ)は画面に出す文言へ漏らさない
    expect(outcome.ok === false && outcome.message).not.toContain("network down");
  });

  it("未ログイン(__AUTH_REQUIRED__)はログイン案内に振り分ける", async () => {
    vi.mocked(authFetch).mockRejectedValue(new Error("__AUTH_REQUIRED__"));
    const { result } = renderHook(() => useAgentChatTransport({ surface: "fullscreen" }));

    let outcome!: Awaited<ReturnType<typeof result.current.send>>;
    await act(async () => { outcome = await result.current.send("送料を教えて"); });

    expect(outcome).toEqual({ ok: false, kind: "auth", message: AGENT_CHAT_AUTH_REQUIRED_MESSAGE });
  });

  it("HTTPエラーでサーバが error を返せばそれを、無ければ共通文言を使う", async () => {
    vi.mocked(authFetch).mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "プランの上限に達しています" }),
    } as Response);
    const { result } = renderHook(() => useAgentChatTransport({ surface: "panel" }));

    let outcome!: Awaited<ReturnType<typeof result.current.send>>;
    await act(async () => { outcome = await result.current.send("送料を教えて"); });
    expect(outcome).toEqual({ ok: false, kind: "http", message: "エラー: プランの上限に達しています" });

    vi.mocked(authFetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("not json")),
    } as unknown as Response);
    await act(async () => { outcome = await result.current.send("送料を教えて"); });
    expect(outcome).toEqual({ ok: false, kind: "http", message: AGENT_CHAT_ERROR_MESSAGE });
  });

  it("成功時はパースしたレスポンスをそのまま返す", async () => {
    vi.mocked(authFetch).mockImplementation(() =>
      mockOk({ reply: "10時から19時です。", actions: [{ tool: "get_faq_list", result: "3件" }], answered_from: "faq_list" }),
    );
    const { result } = renderHook(() => useAgentChatTransport({ surface: "panel" }));

    let outcome!: Awaited<ReturnType<typeof result.current.send>>;
    await act(async () => { outcome = await result.current.send("営業時間を教えて"); });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.data).toEqual({
      reply: "10時から19時です。",
      actions: [{ tool: "get_faq_list", result: "3件" }],
      answered_from: "faq_list",
    });
  });
});

describe("useAgentChatTransport — surface", () => {
  it("受け取った面の識別子をそのまま公開する", () => {
    const { result } = renderHook(() => useAgentChatTransport({ surface: "fullscreen" }));
    expect(result.current.surface).toBe("fullscreen");
  });

  // サーバはこの値を全メトリクスの surface ラベルに載せる(docs/AGENT_METRICS.md)。
  // 送らないと 'unknown' に丸められ、面ごとの比較(docs/CHAT_SURFACE_DECISION.md の
  // 「全画面UIが主たる面になりつつあるのか」)ができなくなる。
  it.each(["panel", "fullscreen"] as const)(
    "設定された面の識別子(%s)をリクエストボディに載せて送る",
    async (surface) => {
      const { result } = renderHook(() => useAgentChatTransport({ surface }));

      await act(async () => { await result.current.send("送料を教えて"); });

      expect(vi.mocked(authFetch).mock.calls.at(-1)![0]).toBe(CHAT_URL);
      expect(lastBody().surface).toBe(surface);
    },
  );

  it("送信を跨いでも面の識別子は変わらない", async () => {
    const { result } = renderHook(() => useAgentChatTransport({ surface: "fullscreen" }));

    await act(async () => { await result.current.send("1通目"); });
    await act(async () => { await result.current.send("2通目"); });

    const bodies = vi.mocked(authFetch).mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(bodies.map((b) => b.surface)).toEqual(["fullscreen", "fullscreen"]);
  });
});
