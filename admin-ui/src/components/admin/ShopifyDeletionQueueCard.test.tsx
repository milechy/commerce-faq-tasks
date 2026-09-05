// admin-ui/src/components/admin/ShopifyDeletionQueueCard.test.tsx
// D15/FR-16/§7 D-5: shop/redact 削除保留監視カード。
// 禁止50の回帰テスト: 保留0件のときに「異常なし」と表示しないこと。
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ShopifyDeletionQueueCard from "./ShopifyDeletionQueueCard";

describe("ShopifyDeletionQueueCard", () => {
  it("保留0件のときは「保留0件」を中立に表示し、異常なしとは言わない", () => {
    render(<ShopifyDeletionQueueCard data={{ pending: [], total: 0 }} />);
    expect(screen.getByText("0")).toBeTruthy();
    expect(screen.getByText(/保留0件/)).toBeTruthy();
    expect(screen.queryByText(/異常なし/)).toBeNull();
  });

  it("期限内(severity:null)の保留は期限表示のみで警告バッジを出さない", () => {
    render(
      <ShopifyDeletionQueueCard
        data={{
          pending: [
            {
              tenantId: "tenant-a",
              shopDomain: "a.myshopify.com",
              deletionRequestedAt: "2026-09-01T00:00:00.000Z",
              deadline: "2026-10-01T00:00:00.000Z",
              daysUntilDeadline: 26,
              severity: null,
            },
          ],
          total: 1,
        }}
      />,
    );
    expect(screen.getByText("a.myshopify.com")).toBeTruthy();
    expect(screen.queryByText("まもなく期限")).toBeNull();
    expect(screen.queryByText("本日が期限")).toBeNull();
    expect(screen.queryByText("期限超過")).toBeNull();
  });

  it("期限超過(severity:critical)は「期限超過」バッジと超過日数を表示する", () => {
    render(
      <ShopifyDeletionQueueCard
        data={{
          pending: [
            {
              tenantId: "tenant-b",
              shopDomain: "b.myshopify.com",
              deletionRequestedAt: "2026-07-01T00:00:00.000Z",
              deadline: "2026-07-31T00:00:00.000Z",
              daysUntilDeadline: -3,
              severity: "critical",
            },
          ],
          total: 1,
        }}
      />,
    );
    expect(screen.getByText("期限超過")).toBeTruthy();
    expect(screen.getByText(/3日超過/)).toBeTruthy();
  });

  it("shopDomainが無い場合はtenantIdで代替表示する", () => {
    render(
      <ShopifyDeletionQueueCard
        data={{
          pending: [
            {
              tenantId: "tenant-c",
              shopDomain: null,
              deletionRequestedAt: "2026-09-01T00:00:00.000Z",
              deadline: "2026-10-01T00:00:00.000Z",
              daysUntilDeadline: 1,
              severity: "warning",
            },
          ],
          total: 1,
        }}
      />,
    );
    expect(screen.getByText("tenant-c")).toBeTruthy();
    expect(screen.getByText("まもなく期限")).toBeTruthy();
  });
});
