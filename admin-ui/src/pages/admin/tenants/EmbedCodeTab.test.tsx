// 回帰ガード: 埋め込みコードのスニペットに widget.js が読まない/実データが無い属性
// (data-title / data-color) を出力し、テナントに "undefined" 文字列をそのまま
// コピペさせてしまっていた不具合(バックエンドが widgetTitle/widgetColor を
// 一度も返していない・widget.js は data-accent-color しか読まない)の再発防止。
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import EmbedCodeTab from "./EmbedCodeTab";
import type { TenantDetail, ApiKey } from "./types";

function makeTenant(overrides: Partial<TenantDetail> = {}): TenantDetail {
  return {
    id: "tenant-a",
    name: "Tenant A",
    slug: "tenant-a",
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

describe("EmbedCodeTab", () => {
  it("生成されるスニペットに undefined 文字列が含まれない（バックエンドが widgetTitle/widgetColor を返さない実際の状況を再現）", () => {
    // 型は string 必須だが、本番のバックエンドはこの2フィールドを一度も返していない。
    // JSON レスポンスに無いフィールドは実行時に undefined になるため、
    // TS の型ではなく実行時の値で再現する（`as unknown as TenantDetail` で型検査を迂回）。
    const tenant = makeTenant({ widgetTitle: undefined, widgetColor: undefined } as unknown as Partial<TenantDetail>);
    render(<EmbedCodeTab tenant={tenant} apiKeys={[]} />);
    const pre = screen.getByText(/data-api-key/);
    expect(pre.textContent).not.toContain("undefined");
  });

  it("widget.js が読まない data-title / data-color を出力しない", () => {
    render(<EmbedCodeTab tenant={makeTenant()} apiKeys={[]} />);
    const pre = screen.getByText(/data-api-key/);
    expect(pre.textContent).not.toContain("data-title");
    expect(pre.textContent).not.toContain("data-color");
  });

  it("widget.js が実際に読む data-api-key / data-tenant は出力する", () => {
    const apiKeys: ApiKey[] = [
      { id: "k1", maskedKey: "r2c_live_****abcd", status: "active", createdAt: "2026-01-01T00:00:00Z", lastUsedAt: null },
    ];
    render(<EmbedCodeTab tenant={makeTenant({ slug: "acme" })} apiKeys={apiKeys} />);
    const pre = screen.getByText(/data-api-key/);
    expect(pre.textContent).toContain('data-api-key="r2c_live_****abcd"');
    expect(pre.textContent).toContain('data-tenant="acme"');
  });

  it("有効なAPIキーが無い場合はプレースホルダーを表示する", () => {
    render(<EmbedCodeTab tenant={makeTenant()} apiKeys={[]} />);
    const pre = screen.getByText(/data-api-key/);
    expect(pre.textContent).toContain('data-api-key="YOUR_API_KEY"');
  });
});
