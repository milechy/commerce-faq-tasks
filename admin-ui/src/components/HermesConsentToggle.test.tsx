// Phase75: HermesConsentToggle unit tests
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HermesConsentToggle } from "./HermesConsentToggle";

vi.mock("../lib/api", () => ({
  authFetch: vi.fn(),
  API_BASE: "http://localhost:3100",
}));

// [A2A-0h]: 文言をi18n化(admin-ui/src/i18n/{ja,en}.ts の hermes_consent.*)したため、
// LangContext を実辞書(ja.ts)をそのまま使う安定した t() に置き換える
// (KnowledgeListTab.test.tsx / [id].test.tsx と同じ既存パターン。LangProvider は
// localStorage に依存し、このテスト環境の Node組み込み localStorage で例外になる)。
vi.mock("../i18n/LangContext", async () => {
  const jaModule = await import("../i18n/ja");
  const ja = jaModule.default as Record<string, string>;
  const stableT = (key: string, vars?: Record<string, string | number>) => {
    let text = ja[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
      }
    }
    return text;
  };
  const stableValue = { lang: "ja" as const, setLang: () => {}, t: stableT };
  return {
    useLang: () => stableValue,
  };
});

import { authFetch } from "../lib/api";

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

function mockInitialFetchWithPlanAndLearning(
  plan: string,
  learning: { learn: boolean; share: boolean } | undefined,
) {
  vi.mocked(authFetch).mockReturnValueOnce(
    mockOk({ plan, features: { avatar: true, voice: false, rag: true, learning } }),
  );
}

beforeEach(() => {
  vi.mocked(authFetch).mockReset();
});

describe("HermesConsentToggle", () => {
  it("T1: 初期取得でhermes_raw_data_consent=false → 「未参加」ボタンを表示する", async () => {
    mockInitialFetch(false);
    render(<HermesConsentToggle />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /共有学習プールに参加する/ })).toBeTruthy();
    });
    expect(screen.getByText("⏸️ 未参加")).toBeTruthy();
  });

  it("T2: 初期取得でhermes_raw_data_consent=true → 「参加中」ボタンを表示する", async () => {
    mockInitialFetch(true);
    render(<HermesConsentToggle />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /参加を取り消す/ })).toBeTruthy();
    });
    expect(screen.getByText("✅ 参加中")).toBeTruthy();
  });

  it("T3: クリックで楽観的更新→PATCH成功で「参加中」に変わる", async () => {
    mockInitialFetch(false);
    vi.mocked(authFetch).mockReturnValueOnce(
      mockOk({ features: { avatar: true, voice: false, rag: true, hermes_raw_data_consent: true } }),
    );
    render(<HermesConsentToggle />);

    await clickWhenEnabled();

    // 楽観的更新: 即座に「保存中...」になる
    expect(screen.getByText("保存中...")).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText("✅ 参加中")).toBeTruthy();
    });
  });

  it("T4: PATCH失敗(500)でロールバックし「未参加」のまま、エラートーストが出る", async () => {
    mockInitialFetch(false);
    vi.mocked(authFetch).mockReturnValueOnce(mockErr(500));
    render(<HermesConsentToggle />);

    await clickWhenEnabled();

    // 初期状態が「未参加」なので、getByText("⏸️ 未参加") はロールバック後だけでなく
    // クリック処理が完了する前でも通ってしまう。既定の 1000ms では CI の負荷時に
    // PATCH の解決が間に合わず、「未参加はあるがトーストが無い」状態でタイムアウトする
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
        expect(screen.getByText("⏸️ 未参加")).toBeTruthy();
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
      expect(screen.getByText("⏸️ 未参加")).toBeTruthy();
    });
  });

  it("T6: PATCHリクエストの本文に既存features(avatar/voice/rag)を保持したまま送る(S5: learning.shareとして送る)", async () => {
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
              hermes_raw_data_consent: false,
              learning: { learn: true, share: true },
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

  it("S5: features.learningが新形式で設定されていれば旧hermes_raw_data_consentより優先する", async () => {
    mockInitialFetchWithPlanAndLearning("starter", { learn: true, share: true });
    render(<HermesConsentToggle />);

    await waitFor(() => {
      expect(screen.getByText("✅ 参加中")).toBeTruthy();
    });
  });

  it("S5: free_adプランでは強制ON表示になり、ボタンが操作不能になる", async () => {
    mockInitialFetchWithPlanAndLearning("free_ad", { learn: true, share: true });
    render(<HermesConsentToggle />);

    await waitFor(() => {
      expect(screen.getByText("🔒 必須(広告プラン)")).toBeTruthy();
    });
    const btn = screen.getByRole("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/広告プラン.*参加が必須/)).toBeTruthy();

    // 操作不能なのでクリックしてもPATCHは飛ばない(押しても何も起きないボタンにはしないが、
    // 「起きるべきでない操作」自体は確実に起きないことを確認する)。
    fireEvent.click(btn);
    expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(1); // 初期GETのみ
  });

  it("S5: 有料プランでは通常どおり操作できる(強制表示は出ない)", async () => {
    mockInitialFetchWithPlanAndLearning("growth", { learn: true, share: false });
    render(<HermesConsentToggle />);

    await waitFor(() => {
      expect(screen.getByText("⏸️ 未参加")).toBeTruthy();
    });
    expect(screen.queryByText("🔒 必須(広告プラン)")).toBeNull();
    const btn = screen.getByRole("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // A2A-0hj テスト強化(2026-09-02): resolveShare / handleToggle の判定ロジック自体は
  // 変更しない。API応答が壊れている場合にこのコンポーネントが例外を投げずfail-safe
  // (未参加表示)に倒れることだけを固定する。
  // ─────────────────────────────────────────────────────────────────────────
  it("features がAPI応答で文字列(壊れた形)のとき、例外を投げずfail-safe(未参加)表示になる", async () => {
    vi.mocked(authFetch).mockReturnValueOnce(mockOk({ plan: "growth", features: "corrupted" }));
    render(<HermesConsentToggle />);

    await waitFor(() => {
      expect(screen.getByText("⏸️ 未参加")).toBeTruthy();
    });
    const btn = screen.getByRole("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false); // free_ad強制ではないので操作は可能
  });

  it("features がAPI応答で数値(壊れた形)のとき、例外を投げずfail-safe(未参加)表示になる", async () => {
    vi.mocked(authFetch).mockReturnValueOnce(mockOk({ plan: "growth", features: 42 }));
    render(<HermesConsentToggle />);

    await waitFor(() => {
      expect(screen.getByText("⏸️ 未参加")).toBeTruthy();
    });
  });

  it("features がAPI応答でnullのとき、例外を投げずfail-safe(未参加)表示になる", async () => {
    vi.mocked(authFetch).mockReturnValueOnce(mockOk({ plan: "growth", features: null }));
    render(<HermesConsentToggle />);

    await waitFor(() => {
      expect(screen.getByText("⏸️ 未参加")).toBeTruthy();
    });
  });

  it("連打: 保存中に同じボタンをもう一度クリックしても二重にPATCHが飛ばない", async () => {
    mockInitialFetch(false);
    let resolvePatch!: (v: Response) => void;
    vi.mocked(authFetch).mockReturnValueOnce(
      new Promise<Response>((r) => {
        resolvePatch = r;
      }),
    );
    render(<HermesConsentToggle />);

    const btn = (await screen.findByRole("button")) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));

    fireEvent.click(btn); // 1回目: 楽観的更新 + PATCH開始、以後 saving=true でdisabled
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn); // 2回目(連打): disabled中なのでhandleToggleの先頭で無視されるはず
    fireEvent.click(btn); // 3回目(連打)

    resolvePatch({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ features: {} }),
    } as Response);

    await waitFor(() => expect(btn.disabled).toBe(false));

    // 初期GET 1回 + PATCH 1回 = 合計2回。連打分が追加でPATCHを飛ばしていないこと。
    expect(vi.mocked(authFetch)).toHaveBeenCalledTimes(2);
  });
});
