// GID 1217808307917235: /admin/knowledge/books が BooksPage(削除済み)ではなく
// /admin/knowledge/global にリダイレクトされていた不具合の回帰テスト。
//
// App.tsx はページを ~30 個 import しているためコンポーネントとして直接レンダーする
// テストは重い(App.tsx 内のコメント参照)。ここでは react-router-dom の
// matchRoutes/createRoutesFromElements を使い、コンポーネントを実際に描画せず
// 「どのパスがどの Route 定義に解決されるか」だけを検証する。
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { createRoutesFromElements, matchRoutes } from "react-router-dom";
import { ADMIN_ROUTES } from "./App";
import TenantKnowledgePage from "./pages/admin/knowledge/[tenantId]";
import KnowledgeIndexPage from "./pages/admin/knowledge/index";
import MarginDashboardPage from "./pages/admin/billing/margin/index";
import BillingPage from "./pages/admin/billing/index";
import { SuperAdminRoute, AdminRoute } from "./components/RoleGuard";

const routes = createRoutesFromElements(ADMIN_ROUTES);

function resolve(pathname: string) {
  const matches = matchRoutes(routes, pathname);
  return matches?.[matches.length - 1] ?? null;
}

describe("ADMIN_ROUTES — /admin/knowledge/*", () => {
  it("/admin/knowledge は KnowledgeIndexPage(テナント選択)に解決される", () => {
    const match = resolve("/admin/knowledge");
    const inner = (match?.route.element as ReactElement<{ children?: ReactElement }>)?.props?.children;
    expect(inner?.type).toBe(KnowledgeIndexPage);
  });

  it("/admin/knowledge/global は TenantKnowledgePage(グローバル)に解決される", () => {
    const match = resolve("/admin/knowledge/global");
    const inner = (match?.route.element as ReactElement<{ children?: ReactElement }>)?.props?.children;
    expect(inner?.type).toBe(TenantKnowledgePage);
  });

  it("/admin/knowledge/:tenantId は動的セグメントとして TenantKnowledgePage に解決される", () => {
    const match = resolve("/admin/knowledge/carnation");
    expect(match?.route.path).toBe("/admin/knowledge/:tenantId");
    const inner = (match?.route.element as ReactElement<{ children?: ReactElement }>)?.props?.children;
    expect(inner?.type).toBe(TenantKnowledgePage);
  });

  it("/admin/knowledge/books は専用の明示的リダイレクトに解決される(BooksPageではない)", () => {
    // 削除前の不具合: BooksPage(13行のリダイレクトスタブ)を経由して
    // /admin/knowledge → /admin/knowledge/global まで2段リダイレクトしていた。
    // 削除後: このパスに専用ルートが無いと /admin/knowledge/:tenantId が
    // "books" を tenantId として拾ってしまう(存在しないテナントの空画面になる)ため、
    // App.tsx 側に明示的な Navigate を残している。ここではその専用ルートに
    // 解決されること — :tenantId に飲み込まれていないこと — を確認する。
    const match = resolve("/admin/knowledge/books");
    expect(match?.route.path).toBe("/admin/knowledge/books");

    const element = match?.route.element as ReactElement<{ to?: string; replace?: boolean }>;
    // <Navigate to="/admin/knowledge" replace /> であること
    expect(element?.props?.to).toBe("/admin/knowledge");
    expect(element?.props?.replace).toBe(true);
  });

  it("/admin/knowledge/booksxyz のような別名は :tenantId に解決される(booksだけの特別扱いではない)", () => {
    const match = resolve("/admin/knowledge/booksxyz");
    expect(match?.route.path).toBe("/admin/knowledge/:tenantId");
  });
});

describe("ADMIN_ROUTES — /admin/billing/*", () => {
  it("/admin/billing/margin は MarginDashboardPage に解決される", () => {
    const match = resolve("/admin/billing/margin");
    const inner = (match?.route.element as ReactElement<{ children?: ReactElement }>)?.props?.children;
    expect(inner?.type).toBe(MarginDashboardPage);
  });

  it("★/admin/billing/margin は SuperAdminRoute でラップされている★", () => {
    // 原価とマージン倍率を同時に描画する画面なので、ロールガードが外れると
    // テナントに粗利率がそのまま漏れる。ガード漏れをここで捕まえる。
    const match = resolve("/admin/billing/margin");
    expect((match?.route.element as ReactElement)?.type).toBe(SuperAdminRoute);
  });

  it("親の /admin/billing は従来どおり AdminRoute(両ロール可)のまま", () => {
    // 子だけ super_admin 限定にしたことで、親のロールを巻き添えで狭めていないこと。
    const match = resolve("/admin/billing");
    expect((match?.route.element as ReactElement)?.type).toBe(AdminRoute);
    const inner = (match?.route.element as ReactElement<{ children?: ReactElement }>)?.props?.children;
    expect(inner?.type).toBe(BillingPage);
  });

  it("/admin/billing/margin が親ルートに食われていない", () => {
    // /admin/billing に動的セグメントを足したときに margin が飲み込まれると、
    // 粗利画面が黙って請求画面になる。パスの一致を明示的に固定する。
    expect(resolve("/admin/billing/margin")?.route.path).toBe("/admin/billing/margin");
  });
});
