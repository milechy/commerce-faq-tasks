import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { InviteTab } from "./InviteTab";
import { authFetch } from "../../../lib/api";

vi.mock("../../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
}));

const mockedAuthFetch = authFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

beforeEach(() => {
  mockedAuthFetch.mockReset();
});

describe("InviteTab", () => {
  it("メール未入力では送信ボタンが無効", () => {
    render(<InviteTab tenantId="t1" />);
    const button = screen.getByRole("button", { name: /招待メールを送信/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("不正なメール形式では送信ボタンが無効でバリデーションメッセージが出る", () => {
    render(<InviteTab tenantId="t1" />);
    const input = screen.getByLabelText("招待するメールアドレス");
    fireEvent.change(input, { target: { value: "not-an-email" } });

    const button = screen.getByRole("button", { name: /招待メールを送信/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/有効なメールアドレスを入力してください/)).toBeTruthy();
  });

  it("送信成功時に成功メッセージを表示し、入力欄をクリアする", async () => {
    mockedAuthFetch.mockResolvedValue(
      jsonResponse(201, { ok: true, userId: "u1", email: "new@example.com", tenantId: "t1", role: "client_admin" })
    );
    render(<InviteTab tenantId="t1" />);
    const input = screen.getByLabelText("招待するメールアドレス") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /招待メールを送信/ }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(/招待しました/);
    });
    expect(input.value).toBe("");
    expect(mockedAuthFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/admin/tenants/t1/invite"),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("metadata_update_failed: 招待は送信済みだがロール設定失敗、という中間状態を明示する", async () => {
    mockedAuthFetch.mockResolvedValue(
      jsonResponse(500, {
        error: "metadata_update_failed",
        message: "招待メールは送信しましたが、ロール設定に失敗しました。手動で設定してください。",
      })
    );
    render(<InviteTab tenantId="t1" />);
    fireEvent.change(screen.getByLabelText("招待するメールアドレス"), {
      target: { value: "half@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /招待メールを送信/ }));

    await waitFor(() => {
      const status = screen.getByRole("status").textContent ?? "";
      expect(status).toMatch(/招待メールは送信されました/);
      expect(status).toMatch(/ロール設定に失敗/);
    });
  });

  it("invite_failed: backendのmessageをそのまま表示する", async () => {
    mockedAuthFetch.mockResolvedValue(
      jsonResponse(400, { error: "invite_failed", message: "既に招待済みのユーザーです。" })
    );
    render(<InviteTab tenantId="t1" />);
    fireEvent.change(screen.getByLabelText("招待するメールアドレス"), {
      target: { value: "dup@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /招待メールを送信/ }));

    await waitFor(() => {
      expect(screen.getByText("既に招待済みのユーザーです。")).toBeTruthy();
    });
  });

  it("tenant_disabled: テナント無効化時の専用文言", async () => {
    mockedAuthFetch.mockResolvedValue(jsonResponse(403, { error: "tenant_disabled" }));
    render(<InviteTab tenantId="t1" />);
    fireEvent.change(screen.getByLabelText("招待するメールアドレス"), {
      target: { value: "x@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /招待メールを送信/ }));

    await waitFor(() => {
      expect(screen.getByText(/無効化されているため/)).toBeTruthy();
    });
  });

  it("通信エラー（fetch自体が例外）でも汎用エラー文言を表示する", async () => {
    mockedAuthFetch.mockRejectedValue(new Error("network down"));
    render(<InviteTab tenantId="t1" />);
    fireEvent.change(screen.getByLabelText("招待するメールアドレス"), {
      target: { value: "y@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /招待メールを送信/ }));

    await waitFor(() => {
      expect(screen.getByText(/通信エラーが発生しました/)).toBeTruthy();
    });
  });
});
