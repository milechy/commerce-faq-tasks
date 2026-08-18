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

// tenantId未指定(undefined)はchatSessionStore側でテナント検証をスキップする既定値。
// 既存テスト(テナント検証を主眼としないもの)はこの既定のまま動く。
function Probe({ tenantId }: { tenantId?: string | null }) {
  const { messages, sessionId, sendMessage } = useAdminAgent(tenantId);
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

  // GID: super_adminがプレビュー中に別テナントへ切り替えても、パネルのキーはsurfaceのみで
  // テナントを区別しないため、前テナントの会話が「復元成功」として通ってしまっていた。
  it("保存時と異なるテナントで開くと、前テナントの会話を復元しない", () => {
    saveChatSession(CHAT_SESSION_SURFACE_PANEL, {
      sessionId: "panel-session-tenant-a",
      messages: [{ role: "user", content: "テナントAの質問" }],
      tenantId: "tenant-a",
    });

    render(<Probe tenantId="tenant-b" />);

    expect(screen.getByTestId("messages").textContent).toBe("");
    expect(screen.getByTestId("session-id").textContent).not.toBe("panel-session-tenant-a");
  });

  it("保存時と同じテナントで開けば、通常どおり会話を復元する", () => {
    saveChatSession(CHAT_SESSION_SURFACE_PANEL, {
      sessionId: "panel-session-tenant-a",
      messages: [{ role: "user", content: "テナントAの質問" }],
      tenantId: "tenant-a",
    });

    render(<Probe tenantId="tenant-a" />);

    expect(screen.getByTestId("messages").textContent).toBe("user:テナントAの質問");
    expect(screen.getByTestId("session-id").textContent).toBe("panel-session-tenant-a");
  });

  it("送信するとパネルのキーへ保存され、全画面UIの会話は書き換わらない", async () => {
    saveChatSession(CHAT_SESSION_SURFACE_FULLSCREEN, {
      sessionId: "fullscreen-session-id",
      messages: [{ id: 1, role: "ai", text: "全画面UIの会話" }],
    });
    const fullscreenBefore = window.sessionStorage.getItem(chatSessionKey(CHAT_SESSION_SURFACE_FULLSCREEN));

    render(<Probe />);
    fireEvent.click(screen.getByText("send"));

    // DOM の描画を待つだけでは足りない。永続化は useAdminAgent の useEffect([messages,...])
    // 経由で走るため、DOM に assistant が出た「後」に sessionStorage が書かれる。
    // その隙間でアサーションが走ると user 1件だけを読んでしまい、CI の負荷が高いときだけ落ちた
    // (#782 で直した useAuth のフレークと同型: 実際に検証したい値ではなく別の指標を待っていた)。
    // ここでは検証対象そのもの = sessionStorage の中身が揃うのを待つ。
    let stored: ReturnType<typeof restoreChatSession<{ role: string; content: string }>>;
    await waitFor(() => {
      stored = restoreChatSession<{ role: string; content: string }>(CHAT_SESSION_SURFACE_PANEL);
      expect(stored?.messages).toHaveLength(2);
    });
    expect(stored!.messages).toEqual([
      { role: "user", content: "営業時間を教えて" },
      { role: "assistant", content: "10時から19時です。", actions: [] },
    ]);
    // 全画面UI側のキーは一切触られていない
    expect(window.sessionStorage.getItem(chatSessionKey(CHAT_SESSION_SURFACE_FULLSCREEN))).toBe(fullscreenBefore);
  });

  // レビュー指摘(P1-2): マウント時の復元検証だけでは、パネルをunmountせずに
  // super_adminがAppSwitcherで別テナントへ切り替えるケースを防げない。以前は
  // 保存effectがtenantIdの変化を無視してそのまま保存し続けており、前テナントの
  // 会話が新テナントの会話として保存され直っていた。
  it("マウント後にtenantIdがライブで変わると、保持中の会話を破棄してから新テナントとして保存し直す", async () => {
    saveChatSession(CHAT_SESSION_SURFACE_PANEL, {
      sessionId: "panel-session-tenant-a",
      messages: [{ role: "user", content: "テナントAの機密の質問" }],
      tenantId: "tenant-a",
    });

    const { rerender } = render(<Probe tenantId="tenant-a" />);
    expect(screen.getByTestId("messages").textContent).toBe("user:テナントAの機密の質問");

    rerender(<Probe tenantId="tenant-b" />);

    await waitFor(() => {
      expect(screen.getByTestId("messages").textContent).toBe("");
    });

    // まだ何も送信していない(messages.length===0)ため保存effectは書き込まないが、
    // 破棄自体はclearChatSessionで即座に行われ、テナントAの会話は残らない。
    const stored = restoreChatSession(CHAT_SESSION_SURFACE_PANEL, "tenant-a");
    expect(stored).toBeNull();
  });

  it("同じtenantIdのままの再レンダーでは会話を破棄しない", () => {
    saveChatSession(CHAT_SESSION_SURFACE_PANEL, {
      sessionId: "panel-session-tenant-a",
      messages: [{ role: "user", content: "テナントAの質問" }],
      tenantId: "tenant-a",
    });

    const { rerender } = render(<Probe tenantId="tenant-a" />);
    rerender(<Probe tenantId="tenant-a" />);

    expect(screen.getByTestId("messages").textContent).toBe("user:テナントAの質問");
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
