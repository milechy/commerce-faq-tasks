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

  it("許可ドメインが空のまま保存すると警告が出るが、保存は実行される", async () => {
    renderTab();
    // originsText は初期状態で空(makeTenant の allowed_origins: [])
    submit();

    expect(screen.getByText(/許可ドメインが空です/)).toBeTruthy();
    await waitFor(() => {
      expect(onSaveMock).toHaveBeenCalledWith(expect.objectContaining({ allowed_origins: [] }));
    });
  });

  it("R2C自身のドメインのみで保存すると警告が出るが、保存は実行される", async () => {
    renderTab();
    const textarea = getOriginsTextarea();
    fireEvent.change(textarea, { target: { value: "https://admin.r2c.biz" } });
    submit();

    expect(screen.getByText(/管理画面のURLしか入っていません/)).toBeTruthy();
    await waitFor(() => {
      expect(onSaveMock).toHaveBeenCalledWith(
        expect.objectContaining({ allowed_origins: ["https://admin.r2c.biz"] })
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
    expect(screen.queryByText(/許可ドメインが空です/)).toBeNull();
    expect(screen.queryByText(/管理画面のURLしか入っていません/)).toBeNull();
  });
});
