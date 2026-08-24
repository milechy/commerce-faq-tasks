// Phase75: HermesConsentToggle unit tests
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HermesConsentToggle } from "./HermesConsentToggle";

vi.mock("../../../lib/api", () => ({
  authFetch: vi.fn(),
  API_BASE: "http://localhost:3100",
}));

import { authFetch } from "../../../lib/api";

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  } as Response);

const mockErr = (status: number): Promise<Response> =>
  Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve({ error: "err" }),
  } as Response);

// 初期取得が終わるまでボタンは disabled のまま。
// findByRole はボタンが「存在する」時点で解決するため、待たずに click すると
// 無効なボタンを押すことになり、後続の「保存中...」が現れずCIが不定期に落ちる
// (2026-08-24: 同一コミットで Gate 3 が success/failure に割れる形で表面化)。
// クリック前に必ず有効化を待つ。
async function clickWhenEnabled(): Promise<HTMLButtonElement> {
  const btn = (await screen.findByRole("button")) as HTMLButtonElement;
  await waitFor(() => expect(btn.disabled).toBe(false));
  fireEvent.click(btn);
  return btn;
}

function mockInitialFetch(consent: boolean) {
  vi.mocked(authFetch).mockReturnValueOnce(
    mockOk({ features: { avatar: true, voice: false, rag: true, hermes_raw_data_consent: consent } }),
  );
}

beforeEach(() => {
  vi.mocked(authFetch).mockReset();
});

describe("HermesConsentToggle", () => {
  it("T1: 初期取得でhermes_raw_data_consent=false → 「未同意」ボタンを表示する", async () => {
    mockInitialFetch(false);
    render(<HermesConsentToggle />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /データ提供に同意する/ })).toBeTruthy();
    });
    expect(screen.getByText("⏸️ 未同意")).toBeTruthy();
  });

  it("T2: 初期取得でhermes_raw_data_consent=true → 「同意済み」ボタンを表示する", async () => {
    mockInitialFetch(true);
    render(<HermesConsentToggle />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /同意を取り消す/ })).toBeTruthy();
    });
    expect(screen.getByText("✅ 同意済み")).toBeTruthy();
  });

  it("T3: クリックで楽観的更新→PATCH成功で「同意済み」に変わる", async () => {
    mockInitialFetch(false);
    vi.mocked(authFetch).mockReturnValueOnce(
      mockOk({ features: { avatar: true, voice: false, rag: true, hermes_raw_data_consent: true } }),
    );
    render(<HermesConsentToggle />);

    await clickWhenEnabled();

    // 楽観的更新: 即座に「保存中...」になる
    expect(screen.getByText("保存中...")).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText("✅ 同意済み")).toBeTruthy();
    });
  });

  it("T4: PATCH失敗(500)でロールバックし「未同意」のまま、エラートーストが出る", async () => {
    mockInitialFetch(false);
    vi.mocked(authFetch).mockReturnValueOnce(mockErr(500));
    render(<HermesConsentToggle />);

    await clickWhenEnabled();

    // 初期状態が「未同意」なので、getByText("⏸️ 未同意") はロールバック後だけでなく
    // クリック処理が完了する前でも通ってしまう。既定の 1000ms では CI の負荷時に
    // PATCH の解決が間に合わず、「未同意はあるがトーストが無い」状態でタイムアウトする
    // (実際に CI で落ちた。ローカルでは PATCH に遅延を注入して再現済み)。
    // まず PATCH が実行されたことを呼び出し回数で確定させ、UI の検証と budget を分ける。
    // こうすると失敗時に「PATCHが飛んでいない」のか「UIが反応していない」のか切り分けられる。
    await waitFor(() => {
      expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(2);
    });

    // トーストは 3000ms で自動的に消える(コンポーネントの setTimeout)。
    // ここの timeout はそれより短くしないと、待っている間に消えて別の理由で落ちる。
    await waitFor(
      () => {
        expect(screen.getByText("⏸️ 未同意")).toBeTruthy();
        expect(screen.getByText("❌ 保存に失敗しました。もう一度お試しください。")).toBeTruthy();
      },
      { timeout: 2000 },
    );
  });

  it("T5: ネットワーク例外でもロールバックする", async () => {
    mockInitialFetch(false);
    vi.mocked(authFetch).mockRejectedValueOnce(new Error("network"));
    render(<HermesConsentToggle />);

    await clickWhenEnabled();

    await waitFor(() => {
      expect(screen.getByText("⏸️ 未同意")).toBeTruthy();
    });
  });

  it("T6: PATCHリクエストの本文に既存features(avatar/voice/rag)を保持したまま送る", async () => {
    mockInitialFetch(false);
    vi.mocked(authFetch).mockReturnValueOnce(mockOk({ features: {} }));
    render(<HermesConsentToggle />);

    await clickWhenEnabled();

    await waitFor(() => {
      expect(vi.mocked(authFetch)).toHaveBeenCalledWith(
        "http://localhost:3100/v1/admin/my-tenant",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            features: {
              avatar: true,
              voice: false,
              rag: true,
              deep_research: undefined,
              pre_dispatch: undefined,
              hermes_raw_data_consent: true,
            },
          }),
        }),
      );
    });
  });

  it("T8: overrideTenantId指定時は /tenants/:id をGET/PATCHする(プレビュー対応, GID 1216273315887508)", async () => {
    mockInitialFetch(false);
    vi.mocked(authFetch).mockReturnValueOnce(
      mockOk({ features: { avatar: true, voice: false, rag: true, hermes_raw_data_consent: true } }),
    );
    render(<HermesConsentToggle overrideTenantId="preview-tenant" />);

    await waitFor(() => {
      expect(vi.mocked(authFetch)).toHaveBeenCalledWith("http://localhost:3100/v1/admin/tenants/preview-tenant");
    });

    await clickWhenEnabled();

    await waitFor(() => {
      expect(vi.mocked(authFetch)).toHaveBeenCalledWith(
        "http://localhost:3100/v1/admin/tenants/preview-tenant",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
  });

  it("T7: saving中はボタンがdisabledになる", async () => {
    mockInitialFetch(false);
    let resolve!: (v: Response) => void;
    vi.mocked(authFetch).mockReturnValueOnce(
      new Promise<Response>((r) => {
        resolve = r;
      }),
    );
    render(<HermesConsentToggle />);

    const btn = (await screen.findByRole("button")) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);

    resolve({ ok: true, status: 200, json: () => Promise.resolve({ features: {} }) } as Response);
    await waitFor(() => expect(btn.disabled).toBe(false));
  });
});
