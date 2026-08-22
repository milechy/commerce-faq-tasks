// 回帰ガード:
// 1) 埋め込みコードのスニペットに widget.js が読まない/実データが無い属性
//    (data-title / data-color) を出力し、テナントに "undefined" 文字列をそのまま
//    コピペさせてしまっていた不具合(バックエンドが widgetTitle/widgetColor を
//    一度も返していない・widget.js は data-accent-color しか読まない)の再発防止。
// 2) ホストが解決不能な cdn.r2c.biz になっており、貼っても絶対に繋がらなかった不具合。
// 3) data-tenant にバックエンドが一度も返さない slug を使っており、常に空になっていた不具合。
// 4) マスク済みキー(****)をそのまま出力しており、貼っても401になっていた不具合。
//    → 平文キーは POST /keys のレスポンスでのみ得られ、二度と取得できない。
//    このタブは「発行直後の1回だけ完全な埋め込みコードを表示する」自己完結フローに変更した。
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import EmbedCodeTab, { buildEmbedCode } from "./EmbedCodeTab";
import type { TenantDetail, ApiKey } from "./types";

// [id].test.tsx と同じ既存パターン: <LangProvider> はこのテスト環境では
// localStorage 例外でマウント時に落ちるため、t() を ja.ts 直読みの安定実装に差し替える。
vi.mock("../../../i18n/LangContext", async () => {
  const jaModule = await import("../../../i18n/ja");
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
  return { useLang: () => ({ lang: "ja" as const, setLang: () => {}, t: stableT }) };
});

vi.mock("../../../components/ApiKeyCreateModal", () => ({
  default: ({
    onSuccess,
    onClose,
  }: {
    tenantId: string;
    onSuccess: (key: string) => void;
    onClose: () => void;
  }) => (
    <div data-testid="issue-modal">
      <button onClick={() => onSuccess("rjc_freshly_issued_key")}>issue-and-succeed</button>
      <button onClick={onClose}>close-modal</button>
    </div>
  ),
}));

function makeTenant(overrides: Partial<TenantDetail> = {}): TenantDetail {
  return {
    id: "tenant-a",
    name: "Tenant A",
    plan: "starter",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    widgetTitle: "",
    widgetColor: "#000",
    allowed_origins: ["https://example.com"],
    billing_enabled: false,
    billing_free_from: null,
    billing_free_until: null,
    features: { avatar: true, voice: false, rag: true },
    lemonslice_agent_id: null,
    conversion_types: [],
    ...overrides,
  };
}

const ACTIVE_KEY: ApiKey = {
  id: "k1",
  maskedKey: "rjc_live_****abcd",
  status: "active",
  createdAt: "2026-01-01T00:00:00Z",
  lastUsedAt: null,
};

// ─── buildEmbedCode（純関数）: スニペット内容そのものの回帰 ─────────────────────

describe("buildEmbedCode", () => {
  it("生成されるスニペットに undefined 文字列が含まれない（バックエンドが widgetTitle/widgetColor を返さない実際の状況を再現）", () => {
    const tenant = makeTenant({ widgetTitle: undefined, widgetColor: undefined } as unknown as Partial<TenantDetail>);
    const code = buildEmbedCode(tenant, "rjc_test_abc123");
    expect(code).not.toContain("undefined");
  });

  it("widget.js が読まない data-title / data-color を出力しない", () => {
    const code = buildEmbedCode(makeTenant(), "rjc_test_abc123");
    expect(code).not.toContain("data-title");
    expect(code).not.toContain("data-color");
  });

  it("実在するホスト(api.r2c.biz)を使う（cdn.r2c.bizはDNS解決不能なため貼っても繋がらない）", () => {
    const code = buildEmbedCode(makeTenant(), "rjc_test_abc123");
    expect(code).toContain("https://api.r2c.biz/widget.js");
    expect(code).not.toContain("cdn.r2c.biz");
  });

  it("data-tenant には tenant.id を使う（slugはバックエンドが一度も返さないため常に空だった）", () => {
    const code = buildEmbedCode(makeTenant({ id: "acme" }), "rjc_test_abc123");
    expect(code).toContain('data-tenant="acme"');
    expect(code).not.toContain("undefined");
  });

  it("data-api-key には渡された実キーをそのまま出力する（マスク済み値は絶対に混入させない）", () => {
    const code = buildEmbedCode(makeTenant(), "rjc_live_abcdefgh12345678");
    expect(code).toContain('data-api-key="rjc_live_abcdefgh12345678"');
    expect(code).not.toContain("****");
    expect(code).not.toContain("YOUR_API_KEY");
  });

  it("widget_theme.primaryColor が設定済みなら data-accent-color を出力する", () => {
    const tenant = makeTenant({ widget_theme: { primaryColor: "#3B82F6" } });
    const code = buildEmbedCode(tenant, "rjc_test_abc123");
    expect(code).toContain('data-accent-color="#3B82F6"');
  });

  it("widget_theme が未設定なら data-accent-color を出力しない", () => {
    const code = buildEmbedCode(makeTenant({ widget_theme: null }), "rjc_test_abc123");
    expect(code).not.toContain("data-accent-color");
  });

  it("primaryColor が #RRGGBB 形式でない場合は出力しない（直接DB編集などによる不正値の防御）", () => {
    const tenant = makeTenant({ widget_theme: { primaryColor: "javascript:alert(1)" } });
    const code = buildEmbedCode(tenant, "rjc_test_abc123");
    expect(code).not.toContain("data-accent-color");
    expect(code).not.toContain("javascript:");
  });

  // 設置位置（サイト右下の「トップへ戻る」ボタン等との重なり回避）。
  // 判定は src/api/admin/agent/widgetPlacement.ts と同一仕様を保つこと。
  it("position / offsetX / offsetY が既定と異なるときだけ data-* 属性を出力する", () => {
    const tenant = makeTenant({ widget_theme: { position: "bottom-left", offsetX: 16, offsetY: 96 } });
    const code = buildEmbedCode(tenant, "rjc_test_abc123");
    expect(code).toContain('data-position="bottom-left"');
    expect(code).toContain('data-offset-x="16"');
    expect(code).toContain('data-offset-y="96"');
  });

  it("既定値と同じ設置位置は出力しない（スニペットを短く保つ）", () => {
    const tenant = makeTenant({ widget_theme: { position: "bottom-right", offsetX: 24, offsetY: 24 } });
    const code = buildEmbedCode(tenant, "rjc_test_abc123");
    expect(code).not.toContain("data-position");
    expect(code).not.toContain("data-offset");
  });

  it("offset 0 は既定と異なるので出力する（falsy 取り違えの回帰）", () => {
    const code = buildEmbedCode(makeTenant({ widget_theme: { offsetX: 0 } }), "rjc_test_abc123");
    expect(code).toContain('data-offset-x="0"');
  });

  it("不正な設置位置は黙って捨てる（直接DB編集などによる不正値の防御）", () => {
    const tenant = makeTenant({ widget_theme: { position: '" onload="alert(1)', offsetY: 9999 } });
    const code = buildEmbedCode(tenant, "rjc_test_abc123");
    expect(code).not.toContain("data-position");
    expect(code).not.toContain("data-offset");
    expect(code).not.toContain("onload");
  });
});

// ─── EmbedCodeTab（コンポーネント）: 平文キーの「発行直後1回だけ表示」フロー ────────

describe("EmbedCodeTab", () => {
  it("平文キー未取得の状態では、埋め込みコードの代わりに案内と発行ボタンを表示する（マスク済みキーは絶対に出さない）", () => {
    render(<EmbedCodeTab tenant={makeTenant()} apiKeys={[ACTIVE_KEY]} />);
    expect(screen.queryByText(/data-api-key/)).toBeNull();
    expect(screen.getByText(/APIキーは表示できません/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /新しいキーを発行して埋め込みコードを取得/ })).toBeTruthy();
  });

  it("有効なキーが無い状態で発行ボタンを押しても再発行の確認は出ない（壊すものが無いため）", () => {
    const confirmSpy = vi.fn();
    window.confirm = confirmSpy;
    render(<EmbedCodeTab tenant={makeTenant()} apiKeys={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /新しいキーを発行して埋め込みコードを取得/ }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("issue-modal")).toBeTruthy();
  });

  it("既に有効なキーがある状態で発行ボタンを押すと、稼働中ウィジェット停止の警告確認が出る。確認を拒否するとモーダルを開かない", () => {
    const confirmSpy = vi.fn().mockReturnValue(false);
    window.confirm = confirmSpy;
    render(<EmbedCodeTab tenant={makeTenant()} apiKeys={[ACTIVE_KEY]} />);
    fireEvent.click(screen.getByRole("button", { name: /新しいキーを発行して埋め込みコードを取得/ }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("再発行すると現在稼働中のウィジェットが停止します"));
    expect(screen.queryByTestId("issue-modal")).toBeNull();
  });

  it("再発行の確認を承諾するとモーダルが開く", () => {
    window.confirm = vi.fn().mockReturnValue(true);
    render(<EmbedCodeTab tenant={makeTenant()} apiKeys={[ACTIVE_KEY]} />);
    fireEvent.click(screen.getByRole("button", { name: /新しいキーを発行して埋め込みコードを取得/ }));
    expect(screen.getByTestId("issue-modal")).toBeTruthy();
  });

  it("キー発行成功後、完全な埋め込みコード（実キー入り）と「二度と表示されない」警告が表示される", () => {
    render(<EmbedCodeTab tenant={makeTenant({ id: "acme" })} apiKeys={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /新しいキーを発行して埋め込みコードを取得/ }));
    fireEvent.click(screen.getByText("issue-and-succeed"));

    expect(screen.getByText(/この画面を離れると二度と表示できません/)).toBeTruthy();
    const pre = screen.getByText(/data-api-key/);
    expect(pre.textContent).toContain('data-api-key="rjc_freshly_issued_key"');
    expect(pre.textContent).toContain('data-tenant="acme"');
    expect(pre.textContent).not.toContain("****");
  });

  it("発行後、案内メッセージと発行ボタンは消え、コピーボタンが表示される", () => {
    render(<EmbedCodeTab tenant={makeTenant()} apiKeys={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /新しいキーを発行して埋め込みコードを取得/ }));
    fireEvent.click(screen.getByText("issue-and-succeed"));

    expect(screen.queryByText(/APIキーは表示できません/)).toBeNull();
    // メイン埋め込みコードのコピーボタンは "📋 コードをコピー"（コンバージョンタグ用の
    // コピーボタンは絵文字無しの同名文言のため、絵文字込みで一意に指定する）。
    expect(screen.getByRole("button", { name: "📋 コードをコピー" })).toBeTruthy();
  });
});
