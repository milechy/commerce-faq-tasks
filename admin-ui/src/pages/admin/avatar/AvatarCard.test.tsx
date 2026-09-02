// AvatarCard: AV-1(デフォルト採用)/AV-2(所有権を見ないアクティブ誤表示)/AV-4(super_admin代行操作)の回帰テスト
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AvatarCard } from "./AvatarCard";
import type { AvatarConfig } from "./types";

vi.mock("../../../i18n/LangContext", () => ({
  useLang: () => ({ lang: "ja" }),
}));

function makeConfig(overrides: Partial<AvatarConfig> = {}): AvatarConfig {
  return {
    id: "cfg-1",
    tenant_id: "tenant-a",
    tenant_name: "Tenant A",
    name: "テスト",
    image_url: null,
    lemonslice_agent_id: null,
    is_active: true,
    is_default: false,
    created_at: "2026-01-01T00:00:00Z",
    avatar_provider: null,
    ...overrides,
  };
}

function setup(props: Partial<Parameters<typeof AvatarCard>[0]> = {}) {
  const handleActivate = vi.fn().mockResolvedValue(undefined);
  const handleDelete = vi.fn().mockResolvedValue(undefined);
  const handleAdopt = vi.fn().mockResolvedValue(undefined);
  const setWarningTarget = vi.fn();
  const formatDate = (iso: string) => iso;

  render(
    <MemoryRouter>
      <AvatarCard
        cfg={makeConfig()}
        isSuperAdmin={false}
        avatarEnabled={true}
        effectiveTenantId="tenant-a"
        tenantFilter="all"
        activating={null}
        deleting={null}
        adopting={null}
        handleActivate={handleActivate}
        handleDelete={handleDelete}
        handleAdopt={handleAdopt}
        setWarningTarget={setWarningTarget}
        formatDate={formatDate}
        {...props}
      />
    </MemoryRouter>
  );
  return { handleActivate, handleDelete, handleAdopt, setWarningTarget };
}

describe("AvatarCard — [AV-2] 所有権を見ないアクティブ誤表示", () => {
  it("自テナント所有の active 行には「アクティブ」が出る", () => {
    setup({
      cfg: makeConfig({ tenant_id: "tenant-a", is_active: true, is_default: false }),
      effectiveTenantId: "tenant-a",
    });
    expect(screen.getByText("アクティブ")).toBeTruthy();
  });

  it("r2c_default所有(未採用)のデフォルト行には「アクティブ」を出さず「見本」を出す", () => {
    setup({
      cfg: makeConfig({ tenant_id: "r2c_default", is_active: true, is_default: true }),
      effectiveTenantId: "tenant-a",
    });
    expect(screen.queryByText("アクティブ")).toBeNull();
    expect(screen.getByText("見本")).toBeTruthy();
  });

  it("採用済み(自テナント所有)のデフォルト行は通常どおり「アクティブ」表示になる", () => {
    setup({
      cfg: makeConfig({ tenant_id: "tenant-a", is_active: true, is_default: true }),
      effectiveTenantId: "tenant-a",
    });
    expect(screen.getByText("アクティブ")).toBeTruthy();
    expect(screen.queryByText("見本")).toBeNull();
  });
});

describe("AvatarCard — [AV-1] デフォルトを「使う」ボタン", () => {
  it("自テナント未所有のデフォルト行に「このデフォルトを使う」ボタンが出て /adopt を呼ぶ", async () => {
    const { handleAdopt } = setup({
      cfg: makeConfig({ id: "def-1", tenant_id: "r2c_default", is_active: true, is_default: true }),
      effectiveTenantId: "tenant-a",
    });
    const btn = screen.getByRole("button", { name: "このデフォルトを使う" });
    btn.click();
    expect(handleAdopt).toHaveBeenCalledWith("def-1");
  });

  it("既に採用済みのデフォルト行にはボタンが出ない", () => {
    setup({
      cfg: makeConfig({ tenant_id: "tenant-a", is_active: true, is_default: true }),
      effectiveTenantId: "tenant-a",
    });
    expect(screen.queryByRole("button", { name: "このデフォルトを使う" })).toBeNull();
  });
});

describe("AvatarCard — [AV-4] super_admin代行操作", () => {
  it("tenantFilterが特定テナントのとき、所有行の有効化ボタンが出る", () => {
    setup({
      isSuperAdmin: true,
      tenantFilter: "tenant-a",
      cfg: makeConfig({ tenant_id: "tenant-a", is_active: false, is_default: false }),
      effectiveTenantId: null,
    });
    expect(screen.getByRole("button", { name: "このテナントのアバターとして有効化" })).toBeTruthy();
  });

  it("tenantFilterが'all'のときは有効化/採用ボタンを一切出さない(誤テナント操作防止)", () => {
    setup({
      isSuperAdmin: true,
      tenantFilter: "all",
      cfg: makeConfig({ tenant_id: "tenant-a", is_active: false, is_default: false }),
      effectiveTenantId: null,
    });
    expect(screen.queryByRole("button", { name: "このテナントのアバターとして有効化" })).toBeNull();
    expect(screen.queryByRole("button", { name: "このテナントでこのデフォルトを使う" })).toBeNull();
  });

  it("tenantFilterが特定テナントのとき、未採用デフォルト行に代行採用ボタンが出て正しいテナントで/adoptを呼ぶ経路になる", () => {
    const { handleAdopt } = setup({
      isSuperAdmin: true,
      tenantFilter: "tenant-b",
      cfg: makeConfig({ id: "def-2", tenant_id: "r2c_default", is_active: true, is_default: true }),
      effectiveTenantId: null,
    });
    const btn = screen.getByRole("button", { name: "このテナントでこのデフォルトを使う" });
    btn.click();
    expect(handleAdopt).toHaveBeenCalledWith("def-2");
  });
});

describe("AvatarCard — previewMode時の従来挙動", () => {
  // previewMode中は isSuperAdmin=false・effectiveTenantId=previewTenantIdとしてindex.tsxから渡される。
  // client_adminパスと同一のためAV-2/AV-1のテストがそのままカバーする(このテストは非破壊の確認用)。
  beforeEach(() => vi.clearAllMocks());

  it("previewMode相当(isSuperAdmin=false)でも自テナント所有の有効化ボタンは従来どおり出る", () => {
    setup({
      isSuperAdmin: false,
      cfg: makeConfig({ tenant_id: "tenant-a", is_active: false, is_default: false }),
      effectiveTenantId: "tenant-a",
    });
    expect(screen.getByRole("button", { name: "有効化" })).toBeTruthy();
  });
});
