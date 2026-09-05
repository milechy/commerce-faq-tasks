// src/api/widget/shopifyRepository.ts
//
// Shopify 連携(docs/SHOPIFY_APP_REQUIREMENTS.md)のうち、tenants テーブルへの
// DB アクセスだけを持つ層。判定ロジック(期限計算・OAuth state 検証等)は
// 置かない(wpProvisionRepository.ts と同じ切り分け方針)。
//
// 対象カラム(shopify_shop_domain / shopify_access_token_encrypted /
// shopify_scope / shopify_installed_at / inflow_source /
// deletion_requested_at / deletion_approved_at / deletion_approved_by)は
// 別PRで追加中(本タスク時点ではDBに未適用)。TypeScript はコンパイル時に
// DBスキーマを検証しないため、マージ順序を待たずに実装してよい
// (Asana GID 1218199958279099 の指示どおり)。
//
// db は引数で受け取る。内部で getPool() を呼ぶと、テストのモック Pool と
// 食い違う(CLAUDE.md: tenantHasFeature が踏んだのと同じ穴)。
//
// アクセストークンは呼び出し側で暗号化済み(src/lib/crypto/textEncrypt.ts の
// encryptText)の文字列を渡す前提。ここでは暗号化/復号を行わない
// (DBアクセス層に暗号処理を混ぜない)。

import type { Pool } from "pg";

/** 既存の analytics 層(schemaHealth.ts / summaryQueries.ts)と同じ最小インターフェース。 */
type Db = Pick<Pool, "query">;

/** WordPress 版 provisioning_source と併存する、テナント全体の流入元マーカー。 */
export type InflowSource = "manual" | "wordpress_plugin" | "shopify_app";

export interface ShopifyTenantRow {
  id: string;
  shopify_shop_domain: string | null;
  /** アクセストークンの暗号文そのものは一般 SELECT に含めない(WP版の秘密値除外方針を踏襲)。 */
  shopify_scope: string | null;
  shopify_installed_at: Date | null;
  inflow_source: string | null;
  deletion_requested_at: Date | null;
  deletion_approved_at: Date | null;
  deletion_approved_by: string | null;
}

export interface PendingDeletionRow {
  id: string;
  shopify_shop_domain: string | null;
  deletion_requested_at: Date;
}

const ROW_COLUMNS = `
  id, shopify_shop_domain, shopify_scope, shopify_installed_at,
  inflow_source, deletion_requested_at, deletion_approved_at, deletion_approved_by
`;

/**
 * shop ドメインからテナントを検索する。
 * 見つからなければ null(禁止20: 「存在しない」と「空」を同じ値で表現しない)。
 */
export async function findTenantByShopDomain(
  db: Db,
  shopDomain: string
): Promise<ShopifyTenantRow | null> {
  const result = await db.query(
    `SELECT ${ROW_COLUMNS} FROM tenants WHERE shopify_shop_domain = $1`,
    [shopDomain]
  );
  return (result.rows[0] as ShopifyTenantRow | undefined) ?? null;
}

/**
 * テナントと shop を紐付ける。shopify_installed_at を現在時刻に設定する。
 * encryptedAccessToken は呼び出し側で暗号化済みの文字列を渡すこと。
 * 戻り値は実際に更新できたか(対象 tenantId が存在したか)。
 */
export async function linkTenantToShop(
  db: Db,
  tenantId: string,
  shopDomain: string,
  encryptedAccessToken: string,
  scope: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE tenants
     SET shopify_shop_domain = $2,
         shopify_access_token_encrypted = $3,
         shopify_scope = $4,
         shopify_installed_at = NOW()
     WHERE id = $1`,
    [tenantId, shopDomain, encryptedAccessToken, scope]
  );
  return (result.rowCount ?? 0) > 0;
}

/** inflow_source を設定する。戻り値は実際に更新できたか。 */
export async function markInflowSource(
  db: Db,
  tenantId: string,
  source: InflowSource
): Promise<boolean> {
  const result = await db.query(`UPDATE tenants SET inflow_source = $2 WHERE id = $1`, [
    tenantId,
    source,
  ]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * shop/redact 受信時に削除保留としてマークする。
 * deletion_approved_at には触れない(人間承認前は NULL のまま、D15)。
 */
export async function markDeletionRequested(db: Db, tenantId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE tenants SET deletion_requested_at = NOW() WHERE id = $1`,
    [tenantId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * 削除保留を人間が承認する(D15)。deletion_requested_at が設定済みの行のみを
 * 対象にする(要求されていない削除を承認できないよう SQL 側で縛る)。
 */
export async function approveDeletion(
  db: Db,
  tenantId: string,
  approvedBy: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE tenants
     SET deletion_approved_at = NOW(), deletion_approved_by = $2
     WHERE id = $1 AND deletion_requested_at IS NOT NULL`,
    [tenantId, approvedBy]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * 削除保留を解除する(D16: 保留中の再インストールでの復元用)。
 * deletion_requested_at / deletion_approved_at / deletion_approved_by を
 * すべて NULL に戻す。
 */
export async function clearDeletionPending(db: Db, tenantId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE tenants
     SET deletion_requested_at = NULL, deletion_approved_at = NULL, deletion_approved_by = NULL
     WHERE id = $1`,
    [tenantId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * 削除保留中(deletion_requested_at はあるが deletion_approved_at が無い)かどうか。
 * テナントが存在しない場合は false を返す(「保留中ではない」の意味として妥当)。
 */
export async function isDeletionPending(db: Db, tenantId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT deletion_requested_at, deletion_approved_at FROM tenants WHERE id = $1`,
    [tenantId]
  );
  const row = result.rows[0] as
    | { deletion_requested_at: Date | null; deletion_approved_at: Date | null }
    | undefined;
  if (!row) {
    return false;
  }
  return row.deletion_requested_at !== null && row.deletion_approved_at === null;
}

/**
 * 削除保留中の全テナントを一覧する。期限(受信日+30日)の計算は別タスクで行うため、
 * ここでは行をそのまま返すのみ。0件のときも空配列を返す(一覧APIなので「不在」と
 * 「空」を区別する必要はない — 対象は必ず存在する tenants 行の絞り込みであるため)。
 */
export async function listPendingDeletions(db: Db): Promise<PendingDeletionRow[]> {
  const result = await db.query(
    `SELECT id, shopify_shop_domain, deletion_requested_at
     FROM tenants
     WHERE deletion_requested_at IS NOT NULL AND deletion_approved_at IS NULL`,
    []
  );
  return result.rows as PendingDeletionRow[];
}
