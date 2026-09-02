import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsTab } from "./SettingsTab";
import type { TenantDetail } from "./types";

vi.mock("../../../i18n/LangContext", () => ({
  useLang: () => ({ t: (key: string) => key }),
}));

// [A2A-0h]: SettingsTab は isSuperAdmin=true で HermesConsentToggle(Super Admin直接操作面)を
// 描画するようになった。同コンポーネントが lib/api の authFetch(supabaseの実セッション取得を
// 経由する)を直接叩くため、モックしないと実ネットワーク/実Supabaseに触れてしまう
// ([id].test.tsx と同じ理由でのモック)。
vi.mock("../../../lib/api", () => ({
  authFetch: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
  API_BASE: "http://localhost:3100",
}));

import { authFetch } from "../../../lib/api";

function makeTenant(overrides: Partial<TenantDetail> = {}): TenantDetail {
  return {
    id: "t1",
    name: "Test Tenant",
    plan: "growth",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    widgetTitle: "Chat",
    widgetColor: "#000000",
    allowed_origins: [],
    billing_enabled: false,
    billing_free_from: null,
    billing_free_until: null,
    features: {} as TenantDetail["features"],
    lemonslice_agent_id: null,
    conversion_types: [],
    ...overrides,
  } as TenantDetail;
}

describe("SettingsTab — allowed_origins バリデーション", () => {
  let onSave: (data: {
    name: string;
    status: "active" | "inactive";
    allowed_origins: string[];
    system_prompt?: string;
    tenant_contact_email?: string | null;
  }) => Promise<void>;
  let onBillingUpdate: (updated: TenantDetail) => void;
  let updateBilling: (
    tenantId: string,
    billing_enabled: boolean,
    billing_free_from: string | null,
    billing_free_until: string | null
  ) => Promise<TenantDetail>;
  let onSaveMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onSaveMock = vi.fn().mockResolvedValue(undefined);
    onSave = onSaveMock as unknown as typeof onSave;
    onBillingUpdate = vi.fn();
    updateBilling = vi.fn() as unknown as typeof updateBilling;
  });

  function renderTab(tenant = makeTenant()) {
    return render(
      <SettingsTab
        tenant={tenant}
        isSuperAdmin={true}
        onSave={onSave}
        onBillingUpdate={onBillingUpdate}
        updateBilling={updateBilling}
      />
    );
  }

  function getOriginsTextarea(): HTMLTextAreaElement {
    // allowed_origins のテキストエリアはこのタブで唯一の textarea ではないため、
    // placeholder で特定する(SettingsTab.tsx の allowed_origins_placeholder キー由来)。
    const textareas = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
    const el = textareas.find((t) => t.tagName === "TEXTAREA" && t.value !== undefined);
    // 最初の textarea が allowed_origins(system_prompt より前に描画される)
    return (el ?? textareas[0]) as HTMLTextAreaElement;
  }

  function submit() {
    const button = screen.getByText("tenant_detail.save_settings");
    fireEvent.click(button);
  }

  it("https:// 始まりでないURLは保存前に拒否される", () => {
    renderTab();
    const textarea = getOriginsTextarea();
    fireEvent.change(textarea, { target: { value: "http://insecure.example.com" } });
    submit();

    expect(screen.getByText(/URLはhttps:\/\/で始まる必要があります/)).toBeTruthy();
    expect(onSaveMock).not.toHaveBeenCalled();
  });

  it("https://*.example.com（サブドメインワイルドカード）は許可される", async () => {
    renderTab();
    const textarea = getOriginsTextarea();
    fireEvent.change(textarea, { target: { value: "https://*.example.com" } });
    submit();

    await waitFor(() => {
      expect(onSaveMock).toHaveBeenCalledWith(
        expect.objectContaining({ allowed_origins: ["https://*.example.com"] })
      );
    });
  });

  it("https://*（全一致ワイルドカード）は保存前に拒否される", () => {
    renderTab();
    const textarea = getOriginsTextarea();
    fireEvent.change(textarea, { target: { value: "https://*" } });
    submit();

    expect(
      screen.getByText(/ワイルドカードは https:\/\/\*\.example\.com の形のみ使用できます/)
    ).toBeTruthy();
    expect(onSaveMock).not.toHaveBeenCalled();
  });

  it("https://*evil.com（先頭ラベル以外のワイルドカード）は保存前に拒否される", () => {
    renderTab();
    const textarea = getOriginsTextarea();
    fireEvent.change(textarea, { target: { value: "https://*evil.com" } });
    submit();

    expect(
      screen.getByText(/ワイルドカードは https:\/\/\*\.example\.com の形のみ使用できます/)
    ).toBeTruthy();
    expect(onSaveMock).not.toHaveBeenCalled();
  });

  it("https://*.a.*.com（ワイルドカード2個）は保存前に拒否される", () => {
    renderTab();
    const textarea = getOriginsTextarea();
    fireEvent.change(textarea, { target: { value: "https://*.a.*.com" } });
    submit();

    expect(
      screen.getByText(/ワイルドカードは https:\/\/\*\.example\.com の形のみ使用できます/)
    ).toBeTruthy();
    expect(onSaveMock).not.toHaveBeenCalled();
  });

  it("通常のhttps URLとワイルドカードの混在は、通常URLが妥当なら保存される", async () => {
    renderTab();
    const textarea = getOriginsTextarea();
    fireEvent.change(textarea, {
      target: { value: "https://shop.example.com\nhttps://*.example.com" },
    });
    submit();

    await waitFor(() => {
      expect(onSaveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          allowed_origins: ["https://shop.example.com", "https://*.example.com"],
        })
      );
    });
  });
});

describe("SettingsTab — 許可ドメインの警告表示(保存はブロックしない)", () => {
  let onSave: (data: {
    name: string;
    status: "active" | "inactive";
    allowed_origins: string[];
    system_prompt?: string;
    tenant_contact_email?: string | null;
  }) => Promise<void>;
  let onBillingUpdate: (updated: TenantDetail) => void;
  let updateBilling: (
    tenantId: string,
    billing_enabled: boolean,
    billing_free_from: string | null,
    billing_free_until: string | null
  ) => Promise<TenantDetail>;
  let onSaveMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onSaveMock = vi.fn().mockResolvedValue(undefined);
    onSave = onSaveMock as unknown as typeof onSave;
    onBillingUpdate = vi.fn();
    updateBilling = vi.fn() as unknown as typeof updateBilling;
  });

  function renderTab(tenant = makeTenant()) {
    return render(
      <SettingsTab
        tenant={tenant}
        isSuperAdmin={true}
        onSave={onSave}
        onBillingUpdate={onBillingUpdate}
        updateBilling={updateBilling}
      />
    );
  }

  function getOriginsTextarea(): HTMLTextAreaElement {
    const textareas = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
    const el = textareas.find((t) => t.tagName === "TEXTAREA" && t.value !== undefined);
    return (el ?? textareas[0]) as HTMLTextAreaElement;
  }

  function submit() {
    const button = screen.getByText("tenant_detail.save_settings");
    fireEvent.click(button);
  }

  // useLang は t: (key) => key でモックしているため、警告文言は実際の翻訳文ではなく
  // i18nキーがそのまま画面に出る。buildOriginWarningLevel が返す level → i18nキーの
  // 配線を確認するテストなので、それで良い(実際の文言のテストは
  // admin-ui/src/lib/tenantOriginWarning.test.ts 側で ja 辞書を直接検証している)。
  it("許可ドメインが空のまま保存すると警告(empty)が出るが、保存は実行される", async () => {
    renderTab();
    // originsText は初期状態で空(makeTenant の allowed_origins: [])
    submit();

    expect(screen.getByText("tenant_detail.origin_warning_empty")).toBeTruthy();
    await waitFor(() => {
      expect(onSaveMock).toHaveBeenCalledWith(expect.objectContaining({ allowed_origins: [] }));
    });
  });

  it("R2C自身のドメインのみで保存すると警告(r2c_own_only, 致命的)が出るが、保存は実行される", async () => {
    renderTab();
    const textarea = getOriginsTextarea();
    fireEvent.change(textarea, { target: { value: "https://admin.r2c.biz" } });
    submit();

    expect(screen.getByText("tenant_detail.origin_warning_r2c_own_only")).toBeTruthy();
    await waitFor(() => {
      expect(onSaveMock).toHaveBeenCalledWith(
        expect.objectContaining({ allowed_origins: ["https://admin.r2c.biz"] })
      );
    });
  });

  it("A2A-0j: R2C自身のドメインが実ドメインに混在すると警告(r2c_own_mixed, 軽度)が出るが、保存は実行される", async () => {
    renderTab();
    const textarea = getOriginsTextarea();
    fireEvent.change(textarea, {
      target: { value: "https://shop.example.com\nhttps://admin.r2c.biz" },
    });
    submit();

    expect(screen.getByText("tenant_detail.origin_warning_r2c_own_mixed")).toBeTruthy();
    // 致命的(r2c_own_only)や空(empty)の警告は同時に出ない
    expect(screen.queryByText("tenant_detail.origin_warning_r2c_own_only")).toBeNull();
    expect(screen.queryByText("tenant_detail.origin_warning_empty")).toBeNull();
    await waitFor(() => {
      expect(onSaveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          allowed_origins: ["https://shop.example.com", "https://admin.r2c.biz"],
        })
      );
    });
  });

  it("テナントの実ドメインが入っていれば警告は出ない", async () => {
    renderTab();
    const textarea = getOriginsTextarea();
    fireEvent.change(textarea, { target: { value: "https://shop.example.com" } });
    submit();

    await waitFor(() => {
      expect(onSaveMock).toHaveBeenCalled();
    });
    expect(screen.queryByText("tenant_detail.origin_warning_empty")).toBeNull();
    expect(screen.queryByText("tenant_detail.origin_warning_r2c_own_only")).toBeNull();
    expect(screen.queryByText("tenant_detail.origin_warning_r2c_own_mixed")).toBeNull();
  });
});

describe("SettingsTab — 警告レベルに応じた色の出し分け(致命的=赤 / 軽度=黄)", () => {
  let onSave: (data: {
    name: string;
    status: "active" | "inactive";
    allowed_origins: string[];
    system_prompt?: string;
    tenant_contact_email?: string | null;
  }) => Promise<void>;
  let onBillingUpdate: (updated: TenantDetail) => void;
  let updateBilling: (
    tenantId: string,
    billing_enabled: boolean,
    billing_free_from: string | null,
    billing_free_until: string | null
  ) => Promise<TenantDetail>;
  let onSaveMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onSaveMock = vi.fn().mockResolvedValue(undefined);
    onSave = onSaveMock as unknown as typeof onSave;
    onBillingUpdate = vi.fn();
    updateBilling = vi.fn() as unknown as typeof updateBilling;
  });

  function renderTab(tenant = makeTenant()) {
    return render(
      <SettingsTab
        tenant={tenant}
        isSuperAdmin={true}
        onSave={onSave}
        onBillingUpdate={onBillingUpdate}
        updateBilling={updateBilling}
      />
    );
  }

  function getOriginsTextarea(): HTMLTextAreaElement {
    const textareas = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
    const el = textareas.find((t) => t.tagName === "TEXTAREA" && t.value !== undefined);
    return (el ?? textareas[0]) as HTMLTextAreaElement;
  }

  function submit() {
    const button = screen.getByText("tenant_detail.save_settings");
    fireEvent.click(button);
  }

  // 色そのもの(SettingsTab.tsx のインラインstyle)を固定する。文言のテストと違い、
  // 「致命的(only)は赤、軽度(mixed/empty)は黄」の分岐が壊れて両方同じ色になっても
  // 文言テストだけでは検知できないため、ここではrole="alert"要素のcolorを直接見る。
  it("r2c_own_only(致命的)は赤系の色(#fca5a5)で表示される", () => {
    renderTab();
    const textarea = getOriginsTextarea();
    fireEvent.change(textarea, { target: { value: "https://admin.r2c.biz" } });
    submit();

    const alert = screen.getByRole("alert");
    expect(alert.style.color).toBe("#fca5a5");
  });

  it("r2c_own_mixed(軽度)は黄系の色(#fbbf24)で表示される(赤ではない)", () => {
    renderTab();
    const textarea = getOriginsTextarea();
    fireEvent.change(textarea, {
      target: { value: "https://shop.example.com\nhttps://admin.r2c.biz" },
    });
    submit();

    const alert = screen.getByRole("alert");
    expect(alert.style.color).toBe("#fbbf24");
    expect(alert.style.color).not.toBe("#fca5a5");
  });

  it("empty(fail-open)は黄系の色(#fbbf24)で表示される(致命的扱いの赤ではない)", () => {
    renderTab();
    submit();

    const alert = screen.getByRole("alert");
    expect(alert.style.color).toBe("#fbbf24");
  });
});

describe("SettingsTab — Hermes同意 super_admin直接操作面(クロステナント事故防止)", () => {
  let onSave: (data: {
    name: string;
    status: "active" | "inactive";
    allowed_origins: string[];
    system_prompt?: string;
    tenant_contact_email?: string | null;
  }) => Promise<void>;
  let onBillingUpdate: (updated: TenantDetail) => void;
  let updateBilling: (
    tenantId: string,
    billing_enabled: boolean,
    billing_free_from: string | null,
    billing_free_until: string | null
  ) => Promise<TenantDetail>;

  beforeEach(() => {
    onSave = vi.fn().mockResolvedValue(undefined);
    onBillingUpdate = vi.fn();
    updateBilling = vi.fn() as unknown as typeof updateBilling;
  });

  // [A2A-0h] SettingsTab は SuperAdminRoute 配下の /admin/tenants/:id からのみ到達する
  // 想定だが、isSuperAdmin プロパティ自体は呼び出し側が渡す値でしかない。ここでは
  // isSuperAdmin=false のとき(=client_adminとして描画されたとき)に、super_admin専用の
  // Hermes同意操作面が一切描画されない(=HermesConsentToggleがマウントされず、対象
  // テナントへのGETすら飛ばない)ことを固定する。
  it("isSuperAdmin=false のとき、Hermes同意のsuper_admin直接操作面を描画しない", () => {
    render(
      <SettingsTab
        tenant={makeTenant({ id: "t-client-admin-should-not-see" })}
        isSuperAdmin={false}
        onSave={onSave}
        onBillingUpdate={onBillingUpdate}
        updateBilling={updateBilling}
      />
    );

    expect(screen.queryByText("hermes_consent.super_admin_section_title")).toBeNull();
    expect(
      vi.mocked(authFetch).mock.calls.some(([url]) =>
        String(url).includes("t-client-admin-should-not-see")
      )
    ).toBe(false);
  });

  // SettingsTab は HermesConsentToggle に overrideTenantId={tenant.id} を渡すことで、
  // 「今開いているテナント」を更新する(自テナント=/my-tenant を誤って更新しない)。
  // HermesConsentToggle.test.tsx はコンポーネント単体でこの配線を確認しているが、
  // SettingsTab側が実際に正しいIDを渡しているかどうかはここでしか確認できない。
  it("isSuperAdmin=true のとき、Hermes同意トグルは自テナントではなく開いているテナントのIDでGETする", async () => {
    render(
      <SettingsTab
        tenant={makeTenant({ id: "t-target-cross-tenant-check" })}
        isSuperAdmin={true}
        onSave={onSave}
        onBillingUpdate={onBillingUpdate}
        updateBilling={updateBilling}
      />
    );

    await waitFor(() => {
      expect(vi.mocked(authFetch)).toHaveBeenCalledWith(
        "http://localhost:3100/v1/admin/tenants/t-target-cross-tenant-check"
      );
    });
    expect(vi.mocked(authFetch)).not.toHaveBeenCalledWith("http://localhost:3100/v1/admin/my-tenant");
  });
});
