// Phase: 相談窓口(返信)機能 — DetailModal 返信欄の回帰テスト
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DetailModal, type AdminFeedback } from "./index";

vi.mock("../../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
}));

import { authFetch } from "../../../lib/api";

const BASE_ITEM: AdminFeedback = {
  id: "fb-1",
  tenant_id: "tenant-abc",
  user_email: "owner@example.com",
  message: "送料の設定はどこから変えますか",
  ai_response: null,
  ai_answered: false,
  status: "new",
  category: "operation_guide",
  priority: "normal",
  admin_notes: null,
  linked_knowledge_gap_id: null,
  reply_body: null,
  replied_at: null,
  replied_by_email: null,
  reply_read_at: null,
  parent_feedback_id: null,
  created_at: "2026-07-28T00:00:00Z",
  updated_at: "2026-07-28T00:00:00Z",
};

function renderModal(item: Partial<AdminFeedback> = {}, isSuperAdmin = true) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const onDeleted = vi.fn();
  render(
    <DetailModal
      item={{ ...BASE_ITEM, ...item }}
      lang="ja"
      isSuperAdmin={isSuperAdmin}
      onClose={onClose}
      onSaved={onSaved}
      onDeleted={onDeleted}
    />
  );
  return { onSaved, onClose, onDeleted };
}

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) } as Response);

const mockErr = (status: number): Promise<Response> =>
  Promise.resolve({ ok: false, status, json: () => Promise.resolve({ error: "err" }) } as Response);

describe("DetailModal — テナントへの返信", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
  });

  it("client_admin(super_admin以外)には返信欄が表示されない", () => {
    renderModal({}, false);
    expect(screen.queryByText("── テナントへの返信 ──")).toBeNull();
  });

  it("super_admin には返信欄が表示され、未入力ではボタンが無効", () => {
    renderModal({}, true);
    expect(screen.getByText("── テナントへの返信 ──")).toBeTruthy();
    const btn = screen.getByRole("button", { name: "返信を送る" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("返信を送ると POST /:id/reply が呼ばれ、送信済みの返信として表示される", async () => {
    vi.mocked(authFetch).mockReturnValue(
      mockOk({ ...BASE_ITEM, reply_body: "設定ページから変更できます", replied_at: "2026-07-28T01:00:00Z" })
    );
    const { onSaved } = renderModal();

    const textarea = screen.getByPlaceholderText("テナントへの返信を入力...");
    fireEvent.change(textarea, { target: { value: "設定ページから変更できます" } });

    const btn = screen.getByRole("button", { name: "返信を送る" });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(vi.mocked(authFetch)).toHaveBeenCalledWith(
        "http://localhost:3100/v1/admin/feedback/fb-1/reply",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ reply_body: "設定ページから変更できます" }),
        })
      );
    });

    expect(await screen.findByText("✅ 送信済みの返信")).toBeTruthy();
    expect(screen.getByText("設定ページから変更できます")).toBeTruthy();
    expect(onSaved).toHaveBeenCalled();
  });

  it("送信失敗時はエラーメッセージを表示し、送信済み表示にはならない", async () => {
    vi.mocked(authFetch).mockReturnValue(mockErr(500));
    renderModal();

    fireEvent.change(screen.getByPlaceholderText("テナントへの返信を入力..."), {
      target: { value: "テスト返信" },
    });
    fireEvent.click(screen.getByRole("button", { name: "返信を送る" }));

    await waitFor(() => {
      expect(screen.getByText("返信の送信に失敗しました")).toBeTruthy();
    });
    expect(screen.queryByText("✅ 送信済みの返信")).toBeNull();
  });

  it("既に返信済みの相談は「送信済みの返信」を初期表示し、続けて返信するプレースホルダーになる", () => {
    renderModal({ reply_body: "既存の返信です", replied_at: "2026-07-27T00:00:00Z" });

    expect(screen.getByText("✅ 送信済みの返信")).toBeTruthy();
    expect(screen.getByText("既存の返信です")).toBeTruthy();
    expect(screen.getByPlaceholderText("続けて返信する場合はこちらに...")).toBeTruthy();
  });

  it("parent_feedback_id がある相談には「前回の続き」バッジが出る", () => {
    renderModal({ parent_feedback_id: "fb-0" });
    expect(screen.getByText("🔗 前回の続き")).toBeTruthy();
  });

  it("parent_feedback_id が無い相談にはバッジが出ない", () => {
    renderModal({});
    expect(screen.queryByText("🔗 前回の続き")).toBeNull();
  });
});
