// GID 1216944249525907: ディープリサーチはEnterpriseプラン以上限定の回帰テスト
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import DeepResearchTab from "./DeepResearchTab";
import type { TenantDetail } from "./types";

vi.mock("../../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
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
    allowed_origins: [],
    billing_enabled: false,
    billing_free_from: null,
    billing_free_until: null,
    features: { avatar: false, voice: false, rag: true, deep_research: false },
    lemonslice_agent_id: null,
    conversion_types: [],
    ...overrides,
  };
}

describe("DeepResearchTab — プラン制限による表示切替", () => {
  it("plan=starter → トグルが無効化され、理由が表示される", () => {
    render(<DeepResearchTab tenant={makeTenant({ plan: "starter" })} onUpdate={vi.fn()} showToast={vi.fn()} />);

    const toggle = screen.getByLabelText("ディープリサーチ切り替え") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText(/Enterpriseプラン以上でご利用いただけます/)).toBeTruthy();
  });

  it("plan=growth → まだEnterprise未達のためトグルは無効", () => {
    render(<DeepResearchTab tenant={makeTenant({ plan: "growth" })} onUpdate={vi.fn()} showToast={vi.fn()} />);

    const toggle = screen.getByLabelText("ディープリサーチ切り替え") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByText(/Enterpriseプラン以上でご利用いただけます/)).toBeTruthy();
  });

  it("plan=enterprise → トグルが有効化され、理由メッセージは表示されない", () => {
    render(<DeepResearchTab tenant={makeTenant({ plan: "enterprise" })} onUpdate={vi.fn()} showToast={vi.fn()} />);

    const toggle = screen.getByLabelText("ディープリサーチ切り替え") as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    expect(screen.queryByText(/Enterpriseプラン以上でご利用いただけます/)).toBeNull();
  });
});
