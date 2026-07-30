// GID 1217007298292152: 会話がリロード・ブラウザバック・タブ破棄で消える不具合の、
// パネル側(Surface A)の回帰テスト。全画面UI(/copilot-preview)とは別キーで保存され、
// 2面の会話が互いを上書きしないことを確認する。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useAdminAgent } from "./useAdminAgent";
import {
  CHAT_SESSION_SURFACE_FULLSCREEN,
  CHAT_SESSION_SURFACE_PANEL,
  chatSessionKey,
  restoreChatSession,
  saveChatSession,
} from "../../lib/chatSessionStore";

vi.mock("../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
}));

import { authFetch } from "../../lib/api";

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) } as Response);

function Probe() {
  const { messages, sessionId, sendMessage } = useAdminAgent();
  return (
    <div>
      <div data-testid="session-id">{sessionId}</div>
      <div data-testid="messages">{messages.map((m) => `${m.role}:${m.content}`).join("|")}</div>
      <button onClick={() => void sendMessage("営業時間を教えて")}>send</button>
    </div>
  );
}

describe("useAdminAgent — 会話の復元(sessionStorage)", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation(() => mockOk({ reply: "10時から19時です。", actions: [] }));
    window.sessionStorage.clear();
  });

  it("保存済みの会話が無ければ空の状態で始まる", () => {
    render(<Probe />);

    expect(screen.getByTestId("messages").textContent).toBe("");
    expect(screen.getByTestId("session-id").textContent).toBeTruthy();
  });

  it("保存済みの会話があればマウント時に復元し、sessionIdも引き継ぐ", () => {
    saveChatSession(CHAT_SESSION_SURFACE_PANEL, {
      sessionId: "panel-session-id",
      messages: [
        { role: "user", content: "送料を教えて" },
        { role: "assistant", content: "全国一律550円です。" },
      ],
    });

    render(<Probe />);

    expect(screen.getByTestId("messages").textContent).toBe(
      "user:送料を教えて|assistant:全国一律550円です。",
    );
    expect(screen.getByTestId("session-id").textContent).toBe("panel-session-id");
  });

  it("送信するとパネルのキーへ保存され、全画面UIの会話は書き換わらない", async () => {
    saveChatSession(CHAT_SESSION_SURFACE_FULLSCREEN, {
      sessionId: "fullscreen-session-id",
      messages: [{ id: 1, role: "ai", text: "全画面UIの会話" }],
    });
    const fullscreenBefore = window.sessionStorage.getItem(chatSessionKey(CHAT_SESSION_SURFACE_FULLSCREEN));

    render(<Probe />);
    fireEvent.click(screen.getByText("send"));

    await waitFor(() =>
      expect(screen.getByTestId("messages").textContent).toContain("assistant:10時から19時です。"),
    );

    const stored = restoreChatSession<{ role: string; content: string }>(CHAT_SESSION_SURFACE_PANEL);
    expect(stored?.messages).toEqual([
      { role: "user", content: "営業時間を教えて" },
      { role: "assistant", content: "10時から19時です。", actions: [] },
    ]);
    // 全画面UI側のキーは一切触られていない
    expect(window.sessionStorage.getItem(chatSessionKey(CHAT_SESSION_SURFACE_FULLSCREEN))).toBe(fullscreenBefore);
  });
});

// GID 1217008695995707: サーバは全メトリクスの surface ラベルにこの値をそのまま載せる
// (docs/AGENT_METRICS.md)。この面が名乗り損ねると、パネル由来のターンが 'unknown' に
// 混ざって面ごとの比較ができなくなる。
describe("useAdminAgent — リクエストボディの surface", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation(() => mockOk({ reply: "10時から19時です。", actions: [] }));
    window.sessionStorage.clear();
  });

  it("送信するリクエストに surface: panel が載る", async () => {
    render(<Probe />);
    fireEvent.click(screen.getByText("send"));

    await waitFor(() => expect(authFetch).toHaveBeenCalled());

    const chatCall = vi
      .mocked(authFetch)
      .mock.calls.find(([url]) => String(url).includes("/v1/admin/agent/chat"))!;
    const body = JSON.parse(String((chatCall[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.surface).toBe("panel");
  });
});
