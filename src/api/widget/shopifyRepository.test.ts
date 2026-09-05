// src/api/widget/shopifyRepository.test.ts
//
// 固定する不変条件:
//   禁止20  「存在しない」と「空」を同じ値で表現しない
//           (findTenantByShopDomain は 0 件で null を返す)
//   D15     approveDeletion は deletion_requested_at が設定済みの行のみを対象にする
//           (要求されていない削除を承認できない)
//   D16     clearDeletionPending は削除保留の3列すべてを NULL に戻す
//
// wpProvisionRepository.test.ts と同じ流儀で、発行される SQL とパラメータを検証する。

import {
  findTenantByShopDomain,
  linkTenantToShop,
  markProvisioningSource,
  markDeletionRequested,
  approveDeletion,
  clearDeletionPending,
  isDeletionPending,
  listPendingDeletions,
} from "./shopifyRepository";

function makeDb(response: { rows?: any[]; rowCount?: number } = {}) {
  const query = jest.fn().mockResolvedValue({
    rows: response.rows ?? [],
    rowCount: response.rowCount ?? (response.rows?.length ?? 0),
  });
  return { db: { query } as any, query };
}

/** 発行された SQL を空白正規化して1行にする(改行・インデントの差を無視するため)。 */
function sqlOf(query: jest.Mock, callIndex = 0): string {
  return String(query.mock.calls[callIndex][0]).replace(/\s+/g, " ").trim();
}

describe("findTenantByShopDomain", () => {
  it("該当テナントがあれば行を返す", async () => {
    const row = {
      id: "tenant-a",
      shopify_shop_domain: "example.myshopify.com",
      shopify_scope: "read_products",
      shopify_installed_at: new Date("2026-09-01T00:00:00Z"),
      provisioning_source: "shopify_app",
      deletion_requested_at: null,
      deletion_approved_at: null,
      deletion_approved_by: null,
    };
    const { db, query } = makeDb({ rows: [row] });
    const result = await findTenantByShopDomain(db, "example.myshopify.com");
    expect(result).toEqual(row);
    expect(sqlOf(query)).toContain("WHERE shopify_shop_domain = $1");
    expect(query.mock.calls[0][1]).toEqual(["example.myshopify.com"]);
  });

  it("該当テナントが無い(0件)場合は null を返す(undefined を漏らさない)", async () => {
    const { db } = makeDb({ rows: [] });
    await expect(findTenantByShopDomain(db, "nobody.myshopify.com")).resolves.toBeNull();
  });

  it("SELECT にアクセストークンの暗号文を含めない", async () => {
    const { db, query } = makeDb({ rows: [] });
    await findTenantByShopDomain(db, "example.myshopify.com");
    const sql = sqlOf(query);
    expect(sql).not.toContain("shopify_access_token_encrypted");
  });
});

describe("linkTenantToShop", () => {
  it("shop・暗号化済みトークン・scope を設定し installed_at を NOW() にする", async () => {
    const { db, query } = makeDb({ rowCount: 1 });
    const result = await linkTenantToShop(
      db,
      "tenant-a",
      "example.myshopify.com",
      "encrypted-token-blob",
      "read_products,write_products"
    );
    expect(result).toBe(true);
    const sql = sqlOf(query);
    expect(sql).toContain("SET shopify_shop_domain = $2");
    expect(sql).toContain("shopify_access_token_encrypted = $3");
    expect(sql).toContain("shopify_scope = $4");
    expect(sql).toContain("shopify_installed_at = NOW()");
    expect(sql).toContain("WHERE id = $1");
    expect(query.mock.calls[0][1]).toEqual([
      "tenant-a",
      "example.myshopify.com",
      "encrypted-token-blob",
      "read_products,write_products",
    ]);
  });

  it("対象テナントが存在しなければ false を返す", async () => {
    const { db } = makeDb({ rowCount: 0 });
    await expect(
      linkTenantToShop(db, "missing", "example.myshopify.com", "token", "scope")
    ).resolves.toBe(false);
  });
});

describe("markProvisioningSource", () => {
  it("provisioning_source を設定する", async () => {
    const { db, query } = makeDb({ rowCount: 1 });
    const result = await markProvisioningSource(db, "tenant-a", "shopify_app");
    expect(result).toBe(true);
    expect(sqlOf(query)).toContain("SET provisioning_source = $2");
    expect(query.mock.calls[0][1]).toEqual(["tenant-a", "shopify_app"]);
  });

  it("対象テナントが存在しなければ false を返す", async () => {
    const { db } = makeDb({ rowCount: 0 });
    await expect(markProvisioningSource(db, "missing", "manual")).resolves.toBe(false);
  });
});

describe("削除保留のライフサイクル(D15/D16)", () => {
  it("markDeletionRequested は deletion_requested_at のみ設定する", async () => {
    const { db, query } = makeDb({ rowCount: 1 });
    const result = await markDeletionRequested(db, "tenant-a");
    expect(result).toBe(true);
    const sql = sqlOf(query);
    expect(sql).toContain("SET deletion_requested_at = NOW()");
    expect(query.mock.calls[0][1]).toEqual(["tenant-a"]);
  });

  it("approveDeletion は deletion_requested_at が設定済みの行のみを対象にする", async () => {
    const { db, query } = makeDb({ rowCount: 1 });
    const result = await approveDeletion(db, "tenant-a", "super-admin@r2c.biz");
    expect(result).toBe(true);
    const sql = sqlOf(query);
    expect(sql).toContain("SET deletion_approved_at = NOW(), deletion_approved_by = $2");
    expect(sql).toContain("WHERE id = $1 AND deletion_requested_at IS NOT NULL");
    expect(query.mock.calls[0][1]).toEqual(["tenant-a", "super-admin@r2c.biz"]);
  });

  it("approveDeletion は削除が要求されていない行には効かない(rowCount=0 → false)", async () => {
    const { db } = makeDb({ rowCount: 0 });
    await expect(approveDeletion(db, "tenant-not-requested", "admin")).resolves.toBe(false);
  });

  it("clearDeletionPending は3列すべてを NULL に戻す", async () => {
    const { db, query } = makeDb({ rowCount: 1 });
    const result = await clearDeletionPending(db, "tenant-a");
    expect(result).toBe(true);
    const sql = sqlOf(query);
    expect(sql).toContain("deletion_requested_at = NULL");
    expect(sql).toContain("deletion_approved_at = NULL");
    expect(sql).toContain("deletion_approved_by = NULL");
    expect(query.mock.calls[0][1]).toEqual(["tenant-a"]);
  });
});

describe("isDeletionPending", () => {
  it("requested があり approved が無ければ true", async () => {
    const { db } = makeDb({
      rows: [{ deletion_requested_at: new Date(), deletion_approved_at: null }],
    });
    await expect(isDeletionPending(db, "tenant-a")).resolves.toBe(true);
  });

  it("requested も approved も設定済みなら false(承認済み=保留中ではない)", async () => {
    const { db } = makeDb({
      rows: [{ deletion_requested_at: new Date(), deletion_approved_at: new Date() }],
    });
    await expect(isDeletionPending(db, "tenant-a")).resolves.toBe(false);
  });

  it("requested が無ければ false(削除保留が一度も要求されていない)", async () => {
    const { db } = makeDb({
      rows: [{ deletion_requested_at: null, deletion_approved_at: null }],
    });
    await expect(isDeletionPending(db, "tenant-a")).resolves.toBe(false);
  });

  it("テナントが存在しない(0件)場合も false を返す", async () => {
    const { db } = makeDb({ rows: [] });
    await expect(isDeletionPending(db, "missing")).resolves.toBe(false);
  });
});

describe("listPendingDeletions", () => {
  it("削除保留中のテナントを一覧する", async () => {
    const rows = [
      { id: "tenant-a", shopify_shop_domain: "a.myshopify.com", deletion_requested_at: new Date() },
      { id: "tenant-b", shopify_shop_domain: "b.myshopify.com", deletion_requested_at: new Date() },
    ];
    const { db, query } = makeDb({ rows });
    const result = await listPendingDeletions(db);
    expect(result).toEqual(rows);
    const sql = sqlOf(query);
    expect(sql).toContain("WHERE deletion_requested_at IS NOT NULL AND deletion_approved_at IS NULL");
  });

  it("0件のときは空配列を返す(nullではない)", async () => {
    const { db } = makeDb({ rows: [] });
    const result = await listPendingDeletions(db);
    expect(result).toEqual([]);
    expect(result).not.toBeNull();
  });
});
