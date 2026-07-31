// admin-ui/src/components/onboarding/OnboardingModal.test.tsx
// GID 1216274591838389 / Asana 1217040715802747(P3)。
// この旧UIモーダルにはこれまでテストが一つも無かった。
// docs/ONBOARDING_FIRST_LOGIN.md §7 の E-9・X-15 に対応する。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import OnboardingModal from "./OnboardingModal";
import { INDUSTRY_FAQ_TEMPLATES } from "./industryFaqTemplates";

vi.mock("../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
}));

import { authFetch } from "../../lib/api";

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as Response);

function selectIndustry() {
  fireEvent.click(screen.getByText("美容・サロン"));
}

describe("OnboardingModal — 業種選択", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockReturnValue(mockOk({}));
  });

  it("業種を選ぶと PATCH /v1/admin/my-tenant で onboarding_industry を保存する", async () => {
    render(<OnboardingModal tenantId="tenant-1" onClose={vi.fn()} />);

    selectIndustry();

    await waitFor(() => {
      expect(vi.mocked(authFetch)).toHaveBeenCalledWith(
        "http://localhost:3100/v1/admin/my-tenant",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ onboarding_industry: "beauty" }),
        }),
      );
    });
  });

  it("業種選択後、テンプレートは全件チェック済みの状態で提示される", async () => {
    render(<OnboardingModal tenantId="tenant-1" onClose={vi.fn()} />);

    selectIndustry();

    const count = INDUSTRY_FAQ_TEMPLATES.beauty.length;
    await waitFor(() => {
      expect(screen.getByText(`選択した${count}件を登録する`)).toBeTruthy();
    });
    // 各テンプレのチェックボックスが実際にcheckedであることも確認する
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes).toHaveLength(count);
    expect(checkboxes.every((c) => c.checked)).toBe(true);
  });

  it("PATCH(onboarding_industry保存)が失敗しても、オンボーディング自体は続行する", async () => {
    vi.mocked(authFetch).mockRejectedValueOnce(new Error("network error"));

    render(<OnboardingModal tenantId="tenant-1" onClose={vi.fn()} />);
    selectIndustry();

    // 保存失敗でも次のステップ(テンプレート提示)には進む
    await waitFor(() => {
      expect(screen.getByText(/FAQのたたき台をご用意しました/)).toBeTruthy();
    });
  });

  // X-15(docs/ONBOARDING_FIRST_LOGIN.md §7.3)
  it("X-15: 「あとで設定する」をクリックすると onClose が呼ばれ、fetchは発生しない", () => {
    const onClose = vi.fn();
    render(<OnboardingModal tenantId="tenant-1" onClose={onClose} />);

    fireEvent.click(screen.getByText("あとで設定する"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(vi.mocked(authFetch)).not.toHaveBeenCalled();
  });
});

describe("OnboardingModal — テンプレート登録(下書き投入)", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
  });

  it("登録は isPublished:false を明示して POST する(Asana 1217040715802747, P3)", async () => {
    vi.mocked(authFetch)
      .mockReturnValueOnce(mockOk({})) // PATCH onboarding_industry
      .mockReturnValueOnce(mockOk({ inserted: INDUSTRY_FAQ_TEMPLATES.beauty.length })); // POST text/commit

    render(<OnboardingModal tenantId="tenant-1" onClose={vi.fn()} />);
    selectIndustry();
    await waitFor(() => expect(screen.getByText(/件を登録する/)).toBeTruthy());

    fireEvent.click(screen.getByText(/件を登録する/));

    await waitFor(() => {
      const commitCall = vi.mocked(authFetch).mock.calls.find(([url]) =>
        String(url).includes("/v1/admin/knowledge/text/commit"),
      );
      expect(commitCall).toBeDefined();
      const body = JSON.parse((commitCall![1] as RequestInit).body as string);
      expect(body.isPublished).toBe(false);
    });
  });

  it("登録成功後は「下書きとして登録しました」の案内が出る(公開前提を明示)", async () => {
    vi.mocked(authFetch)
      .mockReturnValueOnce(mockOk({}))
      .mockReturnValueOnce(mockOk({ inserted: 5 }));

    render(<OnboardingModal tenantId="tenant-1" onClose={vi.fn()} />);
    selectIndustry();
    await waitFor(() => expect(screen.getByText(/件を登録する/)).toBeTruthy());
    fireEvent.click(screen.getByText(/件を登録する/));

    expect(await screen.findByText(/5件のFAQを下書きとして登録しました/)).toBeTruthy();
    expect(screen.getByText(/ナレッジ画面から公開してください/)).toBeTruthy();
  });

  // E-9(docs/ONBOARDING_FIRST_LOGIN.md §7.2)
  it("E-9: 全チェックを外して確定すると、POSTを送らずに完了扱いになる", async () => {
    vi.mocked(authFetch).mockReturnValueOnce(mockOk({})); // PATCH のみ

    render(<OnboardingModal tenantId="tenant-1" onClose={vi.fn()} />);
    selectIndustry();
    await waitFor(() => expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0));

    // 全チェックを外す
    for (const cb of screen.getAllByRole("checkbox")) {
      fireEvent.click(cb);
    }
    expect(screen.getByText("選択した0件を登録する")).toBeTruthy();

    fireEvent.click(screen.getByText("選択した0件を登録する"));

    await waitFor(() => {
      expect(screen.getByText("ナレッジ画面からいつでもFAQを追加できます。")).toBeTruthy();
    });
    // 0件確定では text/commit は一切呼ばれない(PATCHの1回だけ)
    expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1);
  });

  it("チェックを一部だけ外すと、選択した件数だけが登録される", async () => {
    vi.mocked(authFetch)
      .mockReturnValueOnce(mockOk({}))
      .mockReturnValueOnce(mockOk({ inserted: 1 }));

    render(<OnboardingModal tenantId="tenant-1" onClose={vi.fn()} />);
    selectIndustry();
    const checkboxes = await waitFor(() => screen.getAllByRole("checkbox"));
    // 最初の1件以外を外す
    for (let i = 1; i < checkboxes.length; i++) fireEvent.click(checkboxes[i]);

    fireEvent.click(screen.getByText("選択した1件を登録する"));

    await waitFor(() => {
      const commitCall = vi.mocked(authFetch).mock.calls.find(([url]) =>
        String(url).includes("/v1/admin/knowledge/text/commit"),
      );
      const body = JSON.parse((commitCall![1] as RequestInit).body as string);
      expect(body.faqs).toHaveLength(1);
    });
  });

  it("スキップボタンは fetch を送らず完了ステップへ進む", async () => {
    vi.mocked(authFetch).mockReturnValueOnce(mockOk({})); // PATCH のみ

    render(<OnboardingModal tenantId="tenant-1" onClose={vi.fn()} />);
    selectIndustry();
    await waitFor(() => expect(screen.getByText("スキップ")).toBeTruthy());

    fireEvent.click(screen.getByText("スキップ"));

    expect(await screen.findByText("ナレッジ画面からいつでもFAQを追加できます。")).toBeTruthy();
    expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1);
  });
});

describe("OnboardingModal — 登録失敗時のフォールバック", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
  });

  it("POSTが!okを返した場合、エラーメッセージを出して完了ステップに進む(詰まらない)", async () => {
    vi.mocked(authFetch)
      .mockReturnValueOnce(mockOk({}))
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({}) } as Response);

    render(<OnboardingModal tenantId="tenant-1" onClose={vi.fn()} />);
    selectIndustry();
    await waitFor(() => expect(screen.getByText(/件を登録する/)).toBeTruthy());
    fireEvent.click(screen.getByText(/件を登録する/));

    // 実装のバグ修正: 失敗時は成功メッセージ(✅準備完了です！)を出さず、
    // エラー内容が見える形で表示する(以前はerrorステートが計算されるだけで
    // 画面に一切反映されず、失敗時も「準備完了です！」の成功表示になっていた)。
    expect(await screen.findByText(/インポートに失敗しました/)).toBeTruthy();
    expect(screen.queryByText("準備完了です！")).toBeNull();
    expect(screen.getByText("一部設定できませんでした")).toBeTruthy();
  });

  it("POSTが例外を投げても、エラーメッセージを出して完了ステップに進む(詰まらない)", async () => {
    vi.mocked(authFetch)
      .mockReturnValueOnce(mockOk({}))
      .mockRejectedValueOnce(new Error("network error"));

    render(<OnboardingModal tenantId="tenant-1" onClose={vi.fn()} />);
    selectIndustry();
    await waitFor(() => expect(screen.getByText(/件を登録する/)).toBeTruthy());
    fireEvent.click(screen.getByText(/件を登録する/));

    expect(await screen.findByText(/インポートに失敗しました/)).toBeTruthy();
  });
});
