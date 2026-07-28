// Phase: 相談窓口(お返事カード・解決確認プロンプト)の回帰テスト
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AdminAgentPanel from "./AdminAgentPanel";

vi.mock("../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
}));

const mockSendMessage = vi.fn();
let mockMessages: Array<{ role: "user" | "assistant"; content: string; actions?: unknown[]; answeredFrom?: string }> = [];
let mockIsLoading = false;

vi.mock("./useAdminAgent", () => ({
  useAdminAgent: () => ({
    messages: mockMessages,
    isLoading: mockIsLoading,
    sendMessage: mockSendMessage,
  }),
}));

import { authFetch } from "../../lib/api";

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) } as Response);

const REPLY = {
  id: "fb-1",
  message: "送料の設定はどこから変えますか",
  reply_body: "設定ページから変更できます",
  replied_at: "2026-07-28T01:00:00Z",
};

function renderPanel(overrides: Partial<Parameters<typeof AdminAgentPanel>[0]> = {}) {
  const onMarkReplyRead = vi.fn().mockResolvedValue(undefined);
  render(
    <AdminAgentPanel
      isOpen={true}
      onClose={vi.fn()}
      tenantId="tenant-abc"
      isSuperAdmin={false}
      replies={[]}
      onMarkReplyRead={onMarkReplyRead}
      {...overrides}
    />
  );
  return { onMarkReplyRead };
}

describe("AdminAgentPanel — お返事カード", () => {
  beforeEach(() => {
    mockMessages = [];
    mockIsLoading = false;
    mockSendMessage.mockReset();
    vi.mocked(authFetch).mockReset();
  });

  it("replies が空なら「担当者からお返事」カードは表示されない", () => {
    renderPanel({ replies: [] });
    expect(screen.queryByText("💬 担当者からお返事が届きました")).toBeNull();
  });

  it("replies があると質問と返事が表示される", () => {
    renderPanel({ replies: [REPLY] });
    expect(screen.getByText("💬 担当者からお返事が届きました")).toBeTruthy();
    expect(screen.getByText("送料の設定はどこから変えますか")).toBeTruthy();
    expect(screen.getByText("設定ページから変更できます")).toBeTruthy();
  });

  it("2件以上あると「＋あと{n}件」を表示する", () => {
    renderPanel({ replies: [REPLY, { ...REPLY, id: "fb-2" }] });
    expect(screen.getByText("＋あと1件")).toBeTruthy();
  });

  it("「解決しました」クリックで onMarkReplyRead が呼ばれる", async () => {
    const { onMarkReplyRead } = renderPanel({ replies: [REPLY] });
    fireEvent.click(screen.getByText("解決しました"));
    await waitFor(() => {
      expect(onMarkReplyRead).toHaveBeenCalledWith("fb-1");
    });
  });

  it("「まだ解決しません」クリックで既読化 + parent_feedback_id 付きで新規相談が送信される", async () => {
    vi.mocked(authFetch).mockReturnValue(mockOk({ id: "fb-3" }));
    const { onMarkReplyRead } = renderPanel({ replies: [REPLY] });

    fireEvent.click(screen.getByText("まだ解決しません"));

    await waitFor(() => {
      expect(onMarkReplyRead).toHaveBeenCalledWith("fb-1");
      expect(vi.mocked(authFetch)).toHaveBeenCalledWith(
        "http://localhost:3100/v1/admin/feedback",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            message: "送料の設定はどこから変えますか",
            category: "other",
            parent_feedback_id: "fb-1",
          }),
        })
      );
    });
  });
});

describe("AdminAgentPanel — 解決確認プロンプト", () => {
  beforeEach(() => {
    mockSendMessage.mockReset();
    vi.mocked(authFetch).mockReset();
  });

  it("ローディング中は解決確認プロンプトを表示しない", () => {
    mockMessages = [
      { role: "user", content: "設定を教えて" },
      { role: "assistant", content: "確認しました。" },
    ];
    mockIsLoading = true;
    renderPanel();
    expect(screen.queryByText("このお返事で解決しましたか？")).toBeNull();
  });

  it("直近のAI回答の下にのみ解決確認プロンプトを表示する", () => {
    mockMessages = [
      { role: "user", content: "1つ目の質問" },
      { role: "assistant", content: "1つ目の回答" },
      { role: "user", content: "2つ目の質問" },
      { role: "assistant", content: "2つ目の回答" },
    ];
    mockIsLoading = false;
    renderPanel();
    expect(screen.getAllByText("このお返事で解決しましたか？").length).toBe(1);
  });

  it("answeredFrom が faq_list の場合、出どころ表示が出る", () => {
    mockMessages = [
      { role: "user", content: "送料は？" },
      { role: "assistant", content: "550円です。", answeredFrom: "faq_list" },
    ];
    renderPanel();
    expect(screen.getByText("📚 登録した知識データから回答しました")).toBeTruthy();
  });

  it("「うまく解決しなかった」クリックで質問文が feedback として送信され、確認文言に変わる", async () => {
    mockMessages = [
      { role: "user", content: "割引クーポンはありますか" },
      { role: "assistant", content: "申し訳ございません、その情報は登録されていません。" },
    ];
    vi.mocked(authFetch).mockReturnValue(mockOk({ id: "fb-9" }));
    renderPanel();

    fireEvent.click(screen.getByText("うまく解決しなかった"));

    await waitFor(() => {
      expect(vi.mocked(authFetch)).toHaveBeenCalledWith(
        "http://localhost:3100/v1/admin/feedback",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ message: "割引クーポンはありますか", category: "other" }),
        })
      );
    });

    expect(await screen.findByText("✅ 担当者に伝えました。お返事はこの画面に届きます。")).toBeTruthy();
  });

  it("「はい」クリックでプロンプトは消え、APIは呼ばれない", () => {
    mockMessages = [
      { role: "user", content: "設定を教えて" },
      { role: "assistant", content: "確認しました。" },
    ];
    renderPanel();

    fireEvent.click(screen.getByText("はい"));

    expect(screen.queryByText("このお返事で解決しましたか？")).toBeNull();
    expect(authFetch).not.toHaveBeenCalled();
  });
});
