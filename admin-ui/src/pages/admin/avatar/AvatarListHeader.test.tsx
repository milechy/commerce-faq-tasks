// AvatarListHeader: [AV-3] 作成ボタンのプランゲート回帰テスト
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AvatarListHeader } from "./AvatarListHeader";
import type { TenantPlan } from "../../../auth/useAuth";

vi.mock("../../../i18n/LangContext", () => ({
  useLang: () => ({ lang: "ja" }),
}));

function renderHeader(tenantPlan: TenantPlan | null) {
  return render(
    <MemoryRouter>
      <AvatarListHeader
        loading={false}
        isSuperAdmin={false}
        displayedConfigs={[]}
        total={0}
        tenantPlan={tenantPlan}
      />
    </MemoryRouter>
  );
}

describe("AvatarListHeader — [AV-3] avatar_customize(Growth〜)プランゲート", () => {
  it("Growthでは作成ボタンが活性化し、理由メッセージは出ない", () => {
    renderHeader("growth");
    expect((screen.getByRole("button", { name: /新規作成/ }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: /AI生成/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/Growthプラン以上でご利用いただけます/)).toBeNull();
  });

  it("Enterpriseでは作成ボタンが活性化する", () => {
    renderHeader("enterprise");
    expect((screen.getByRole("button", { name: /新規作成/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("Standardでは作成ボタンが非活性化し、理由が表示される", () => {
    renderHeader("standard");
    expect((screen.getByRole("button", { name: /新規作成/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /AI生成/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Growthプラン以上でご利用いただけます/)).toBeTruthy();
    expect(screen.getByText(/現在のプラン: Standard/)).toBeTruthy();
  });

  it("Starterでは作成ボタンが非活性化する", () => {
    renderHeader("starter");
    expect((screen.getByRole("button", { name: /新規作成/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("tenantPlanがnull(未取得)の間はfail-safeで非活性のまま", () => {
    renderHeader(null);
    expect((screen.getByRole("button", { name: /新規作成/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /AI生成/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("ボタン自体は隠さない(非活性+理由表示のみ)", () => {
    renderHeader("starter");
    expect(screen.getByRole("button", { name: /新規作成/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /AI生成/ })).toBeTruthy();
  });
});
