// GID 1216944004404664: 事前ディスパッチ(pre_dispatch)はEnterpriseプラン限定の回帰テスト
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AvatarTab } from "./AvatarTab";
import type { TenantDetail } from "./types";

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
    features: { avatar: true, voice: false, rag: true },
    lemonslice_agent_id: null,
    conversion_types: [],
    ...overrides,
  };
}

function renderTab(tenant: TenantDetail) {
  return render(
    <MemoryRouter>
      <AvatarTab tenant={tenant} onUpdate={vi.fn()} updateAvatarSettings={vi.fn()} />
    </MemoryRouter>,
  );
}

// 「アバター事前起動」カードの2つ上の親(カード全体)からトグルボタンを取得する。
// 「⏸️ 無効」は音声会話トグルにも同じ文言があるため、カード単位で絞り込む必要がある。
function getPreDispatchToggle(): HTMLButtonElement {
  const heading = screen.getByText("アバター事前起動（高速表示）");
  const card = heading.parentElement?.parentElement as HTMLElement;
  return within(card).getByRole("button") as HTMLButtonElement;
}

describe("AvatarTab — 事前ディスパッチのプラン制限", () => {
  it("plan=starter かつ未設定 → トグルが無効化され、理由が表示される", () => {
    renderTab(makeTenant({ plan: "starter", features: { avatar: true, voice: false, rag: true, pre_dispatch: false } }));

    expect(getPreDispatchToggle().disabled).toBe(true);
    expect(screen.getByText(/事前ディスパッチはEnterpriseプラン以上でご利用いただけます/)).toBeTruthy();
  });

  it("plan=growth → まだEnterprise未達のためトグルは無効", () => {
    renderTab(makeTenant({ plan: "growth", features: { avatar: true, voice: false, rag: true, pre_dispatch: false } }));

    expect(getPreDispatchToggle().disabled).toBe(true);
  });

  it("plan=enterprise → トグルが有効化され、理由メッセージは表示されない", () => {
    renderTab(makeTenant({ plan: "enterprise", features: { avatar: true, voice: false, rag: true, pre_dispatch: false } }));

    expect(getPreDispatchToggle().disabled).toBe(false);
    expect(screen.queryByText(/事前ディスパッチはEnterpriseプラン以上でご利用いただけます/)).toBeNull();
  });

  it("plan=starter でも既にON(ダウングレード後)ならOFFへの切り替えは許可される", () => {
    renderTab(makeTenant({ plan: "starter", features: { avatar: true, voice: false, rag: true, pre_dispatch: true } }));

    expect(getPreDispatchToggle().disabled).toBe(false);
  });
});
