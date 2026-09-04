// src/api/widget/wpProvisionRepository.ts
//
// wp_provisionings（migration: src/migrations/phase78_wp_provisionings.sql）への
// DB アクセスだけを持つ層。判定ロジックは置かない。
//
// ・期限切れの判定は呼び出し側が wpProvisionToken.isWpSecretExpired で行う。
//   ここに持ち込むと「DBの状態」と「時間による失効」が同じ関数に混ざり、
//   テストのために時計を差し替える必要が出る。
// ・db は引数で受け取る。内部で getPool() を呼ぶと、テストのモック Pool と
//   食い違う（CLAUDE.md: tenantHasFeature が踏んだのと同じ穴）。
//
// テナント述語について:
//   この表は「まだテナントが存在しない申告」を持つため、行をテナントで分離できない
//   （禁止24 のテナント述語は適用対象外）。代わりに site_origin と各ハッシュを
//   キーにして引く。ハッシュを知らなければ他人の行に触れない。

import type { Pool } from "pg";

/** 既存の analytics 層（schemaHealth.ts / summaryQueries.ts）と同じ最小インターフェース。 */
type Db = Pick<Pool, "query">;

export type WpProvisioningStatus =
  | "pending"
  | "site_verified"
  | "provisioned"
  | "expired"
  | "failed";

export interface WpProvisioningRow {
  id: string;
  site_origin: string;
  email: string;
  status: WpProvisioningStatus;
  tenant_id: string | null;
  failure_reason: string | null;
  created_at: Date;
  site_verified_at: Date | null;
  email_verified_at: Date | null;
  provisioned_at: Date | null;
}

export interface CreateWpProvisioningParams {
  /** normalizeWpSiteUrl() が返した正規化済み origin。生の site_url を渡さない。 */
  siteOrigin: string;
  email: string;
  challengeHash: string;
  pollTokenHash: string;
  /** 以下は要件書 FR-03 の範囲。未申告なら null。 */
  siteName?: string | null;
  wpVersion?: string | null;
  pluginVersion?: string | null;
  locale?: string | null;
}

/**
 * SELECT で返す列。秘密値のハッシュ（challenge_hash / poll_token_hash）は
 * 意図的に含めない。呼び出し側が誤ってレスポンスへ載せる事故を、
 * 型と SQL の両方で防ぐ。
 */
const ROW_COLUMNS = `
  id, site_origin, email, status, tenant_id, failure_reason,
  created_at, site_verified_at, email_verified_at, provisioned_at
`;

/** 申告を1件記録する。status は DB 既定の 'pending'。 */
export async function createWpProvisioning(
  db: Db,
  params: CreateWpProvisioningParams
): Promise<WpProvisioningRow> {
  const result = await db.query(
    `INSERT INTO wp_provisionings
       (site_origin, email, challenge_hash, poll_token_hash, site_name, wp_version, plugin_version, locale)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${ROW_COLUMNS}`,
    [
      params.siteOrigin,
      params.email,
      params.challengeHash,
      params.pollTokenHash,
      params.siteName ?? null,
      params.wpVersion ?? null,
      params.pluginVersion ?? null,
      params.locale ?? null,
    ]
  );
  return result.rows[0] as WpProvisioningRow;
}

/** ポーリング用トークンのハッシュで引く。見つからなければ null。 */
export async function findWpProvisioningByPollTokenHash(
  db: Db,
  pollTokenHash: string
): Promise<WpProvisioningRow | null> {
  const result = await db.query(
    `SELECT ${ROW_COLUMNS} FROM wp_provisionings WHERE poll_token_hash = $1`,
    [pollTokenHash]
  );
  return (result.rows[0] as WpProvisioningRow | undefined) ?? null;
}

/**
 * チャレンジのハッシュで引く。サイト所有証明の照合に使う。
 * 未確定のものだけを対象にする（確定済みの行のチャレンジを再利用させない）。
 */
export async function findPendingWpProvisioningByChallengeHash(
  db: Db,
  challengeHash: string
): Promise<WpProvisioningRow | null> {
  const result = await db.query(
    `SELECT ${ROW_COLUMNS} FROM wp_provisionings
     WHERE challenge_hash = $1 AND status = 'pending'`,
    [challengeHash]
  );
  return (result.rows[0] as WpProvisioningRow | undefined) ?? null;
}

/**
 * その origin で既に発行済みの行を引く。
 * 同一ドメインからの2度目の接続要求（要件書 I-3 / I-4）を、新規作成ではなく
 * 既存テナントへの接続要求として扱うための判定に使う。
 * DB 側にも部分ユニークインデックスがあるため、返るのは高々1件。
 */
export async function findProvisionedWpProvisioningBySiteOrigin(
  db: Db,
  siteOrigin: string
): Promise<WpProvisioningRow | null> {
  const result = await db.query(
    `SELECT ${ROW_COLUMNS} FROM wp_provisionings
     WHERE site_origin = $1 AND status = 'provisioned'`,
    [siteOrigin]
  );
  return (result.rows[0] as WpProvisioningRow | undefined) ?? null;
}

/**
 * サイト所有証明が通ったことを記録する。
 * pending からのみ遷移させる（二重適用・巻き戻しを SQL 側で防ぐ）。
 * 戻り値は実際に遷移したかどうか。
 */
export async function markWpProvisioningSiteVerified(db: Db, id: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE wp_provisionings
     SET status = 'site_verified', site_verified_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'pending'`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * テナント発行の完了を記録する。site_verified からのみ遷移させる
 * ＝ サイト所有証明を通さずに provisioned へ飛ぶ経路を SQL で塞ぐ（FR-04）。
 *
 * 同一 origin に確定行が既にある場合は部分ユニークインデックスが働いて
 * 一意制約違反になる。呼び出し側はそれを 409 として扱う（要件書 X-3）。
 */
export async function markWpProvisioningProvisioned(
  db: Db,
  id: string,
  tenantId: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE wp_provisionings
     SET status = 'provisioned',
         tenant_id = $2,
         email_verified_at = COALESCE(email_verified_at, NOW()),
         provisioned_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND status = 'site_verified'`,
    [id, tenantId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * 失敗を記録する。確定済み（provisioned）は失敗に落とさない。
 * reason は利用者に「なぜ到達できないか」を返すためのコードで、文言ではない。
 */
export async function markWpProvisioningFailed(
  db: Db,
  id: string,
  reason: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE wp_provisionings
     SET status = 'failed', failure_reason = $2, updated_at = NOW()
     WHERE id = $1 AND status <> 'provisioned'`,
    [id, reason]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * 期限超過した未確定の行を expired にする。
 * 「存在しない」と「期限切れ」を区別して返すため、行は消さない（→ 禁止20）。
 * 対象は pending / site_verified のみ。
 */
/**
 * 検証専用: challenge_hash だけを返す。他のSELECTには絶対に混ぜない
 * (ROW_COLUMNS を使う一般のSELECTは公開APIのレスポンスに載る可能性があるため、
 * ハッシュを含めない設計にしている。この関数はサーバ内部の照合処理だけが呼ぶ)。
 * pending の行のみを対象にする(site_verified/provisioned は再照合の必要が無い)。
 */
export async function getWpProvisioningChallengeHashForVerification(
  db: Db,
  id: string
): Promise<string | null> {
  const result = await db.query(
    `SELECT challenge_hash FROM wp_provisionings WHERE id = $1 AND status = 'pending'`,
    [id]
  );
  return (result.rows[0]?.challenge_hash as string | undefined) ?? null;
}

export async function expireStaleWpProvisionings(
  db: Db,
  ttlHours: number
): Promise<number> {
  const result = await db.query(
    `UPDATE wp_provisionings
     SET status = 'expired', updated_at = NOW()
     WHERE status IN ('pending', 'site_verified')
       AND created_at < NOW() - ($1 || ' hours')::interval`,
    [String(ttlHours)]
  );
  return result.rowCount ?? 0;
}

/**
 * プラグイン経由で発行済みのテナント数。総量ガード（要件書 §5.4 / D7）の
 * 「同時稼働数」の分子になる。
 */
export async function countProvisionedWpTenants(db: Db): Promise<number> {
  const result = await db.query(
    `SELECT COUNT(*)::int AS count FROM wp_provisionings WHERE status = 'provisioned'`,
    []
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * 指定時刻以降に作られた申告の件数。総量ガードの「日次作成数」に使う。
 * 境界は呼び出し側が Date で渡す（process TZ に依存させない → 禁止16）。
 */
export async function countWpProvisioningsCreatedSince(db: Db, since: Date): Promise<number> {
  const result = await db.query(
    `SELECT COUNT(*)::int AS count FROM wp_provisionings WHERE created_at >= $1`,
    [since]
  );
  return Number(result.rows[0]?.count ?? 0);
}
