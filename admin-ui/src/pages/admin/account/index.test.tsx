// admin-ui/src/pages/admin/account/index.test.tsx
// ログイン後にパスワードを変更できることの回帰テスト。
//
// 背景: 変更手段が ResetPassword.tsx(ログイン前)しか無く、忘れていないのに
// 「パスワードを忘れた方」の導線でログアウトしてやり直す必要があった。
// super_admin / client_admin を問わず全ユーザーが対象。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AccountPage from "./index";
import { supabase } from "../../../lib/supabaseClient";
import { useAuth } from "../../../auth/useAuth";

vi.mock("../../../auth/useAuth", () => ({
  useAuth: vi.fn(),
}));

vi.mock("../../../lib/supabaseClient", () => ({
  supabase: { auth: { updateUser: vi.fn() } },
}));

// t() はキーをそのまま返すのではなく実辞書(ja.ts)を引く。
// キー名を返すだけのモックだと「間違ったキーを参照していても素通りする」ため、
// 画面に実際に出る日本語で検証できるようにする(既存パターンを踏襲)。
vi.mock("../../../i18n/LangContext", async () => {
  const jaModule = await import("../../../i18n/ja");
  const ja = jaModule.default as Record<string, string>;
  const stableT = (key: string) => ja[key] ?? key;
  return { useLang: () => ({ lang: "ja" as const, setLang: () => {}, t: stableT }) };
});

const mockUpdateUser = supabase.auth.updateUser as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: "u1", email: "t.akamine@example.test", role: "super_admin", tenantId: null, tenantName: null },
    isSuperAdmin: true,
  } as unknown as ReturnType<typeof useAuth>);
  mockUpdateUser.mockReset();
  mockUpdateUser.mockResolvedValue({ error: null });
});

function fillAndSubmit(pw: string, confirm: string) {
  const inputs = screen.getAllByDisplayValue("");
  fireEvent.change(inputs[0]!, { target: { value: pw } });
  fireEvent.change(inputs[1]!, { target: { value: confirm } });
  fireEvent.click(screen.getByRole("button", { name: "パスワードを変更" }));
}

describe("AccountPage — パスワード変更", () => {
  it("8文字以上かつ一致していれば updateUser を呼び、成功メッセージを出す", async () => {
    render(<AccountPage />);
    fillAndSubmit("newpassword123", "newpassword123");

    await waitFor(() => {
      expect(mockUpdateUser).toHaveBeenCalledWith({ password: "newpassword123" });
    });
    await waitFor(() => {
      expect(screen.getByText("パスワードを変更しました。")).toBeTruthy();
    });
  });

  it("8文字未満なら updateUser を呼ばずにエラーを出す", async () => {
    render(<AccountPage />);
    fillAndSubmit("short", "short");

    await waitFor(() => {
      expect(screen.getByText("パスワードは8文字以上で入力してください。")).toBeTruthy();
    });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("確認入力が一致しなければ updateUser を呼ばずにエラーを出す", async () => {
    render(<AccountPage />);
    fillAndSubmit("newpassword123", "different123");

    await waitFor(() => {
      expect(screen.getByText("パスワードが一致しません。")).toBeTruthy();
    });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("Supabase がエラーを返したらエラーメッセージを出し、成功表示はしない", async () => {
    mockUpdateUser.mockResolvedValue({ error: { message: "boom" } });
    render(<AccountPage />);
    fillAndSubmit("newpassword123", "newpassword123");

    await waitFor(() => {
      expect(screen.getByText("パスワードの変更に失敗しました。時間をおいて再度お試しください。")).toBeTruthy();
    });
    expect(screen.queryByText("パスワードを変更しました。")).toBeNull();
  });

  it("成功後は入力欄を空にする(変更後のパスワードを画面に残さない)", async () => {
    render(<AccountPage />);
    fillAndSubmit("newpassword123", "newpassword123");

    await waitFor(() => {
      expect(screen.getByText("パスワードを変更しました。")).toBeTruthy();
    });
    // 2本とも空に戻っている
    expect(screen.getAllByDisplayValue("")).toHaveLength(2);
  });

  it("client_admin でも利用できる(super_admin 専用ではない)", async () => {
    vi.mocked(useAuth).mockReturnValue({
      user: { id: "u2", email: "tenant@example.test", role: "client_admin", tenantId: "accept", tenantName: "Accept" },
      isSuperAdmin: false,
    } as unknown as ReturnType<typeof useAuth>);

    render(<AccountPage />);
    fillAndSubmit("newpassword123", "newpassword123");

    await waitFor(() => {
      expect(mockUpdateUser).toHaveBeenCalledWith({ password: "newpassword123" });
    });
  });
});
