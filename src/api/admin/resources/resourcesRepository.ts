// src/api/admin/resources/resourcesRepository.ts
//
// tenant_resources への DB アクセス層 + Supabase Storage アップロード。
// tenantId は呼び出し側(routes.ts)が req.tenantId(認証済みコンテキスト)から解決済みの値を渡す。
// このファイル自身はどこからも tenantId を取得しない。
//
// db は引数で受け取る。内部で getPool() を呼ぶと、テストのモック Pool と食い違う
// （wpProvisionRepository.ts / CLAUDE.md「tenantHasFeature が踏んだのと同じ穴」と同じ理由）。

import type { Pool } from "pg";
import { supabaseAdmin } from "../../../auth/supabaseClient";
import { logger } from "../../../lib/logger";

type Db = Pick<Pool, "query">;

export type ResourceModerationStatus = "pending" | "approved" | "rejected";

export interface TenantResourceRow {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  storage_path: string | null;
  external_url: string | null;
  file_type: string | null;
  moderation_status: ResourceModerationStatus;
  moderation_reason: string | null;
  rights_confirmed: boolean;
  is_published: boolean;
  created_at: string;
  updated_at: string;
}

const ROW_COLUMNS = `
  id, tenant_id, title, description, storage_path, external_url, file_type,
  moderation_status, moderation_reason, rights_confirmed, is_published,
  created_at, updated_at
`;

/** テナントの資料(1件固定)を取得する。無ければ null（「不在」と「空」は同じ意味なので404ではなくnullで返す）。 */
export async function getResource(db: Db, tenantId: string): Promise<TenantResourceRow | null> {
  const result = await db.query(
    `SELECT ${ROW_COLUMNS} FROM tenant_resources WHERE tenant_id = $1`,
    [tenantId]
  );
  return (result.rows[0] as TenantResourceRow | undefined) ?? null;
}

export interface UpsertResourceParams {
  /** 新規作成時に呼び出し側(routes.ts)が生成したUUID。既存資料の更新時は既存行のidを渡す
   *  （Storage のパス `${tenantId}/${resourceId}.${ext}` を先に確定させる必要があるため、
   *  DBのDEFAULT gen_random_uuid()には頼らない）。 */
  id: string;
  tenantId: string;
  title: string;
  description?: string | null;
  storagePath?: string | null;
  externalUrl?: string | null;
  fileType: string;
  moderationStatus: ResourceModerationStatus;
  moderationReason?: string | null;
  rightsConfirmed: boolean;
}

/**
 * 1テナント1件を UNIQUE(tenant_id) 制約で保証する upsert。
 * 再アップロードのたびに is_published は false に戻す
 * （CLAUDE.md 絶対にやってはいけないこと5: 確認前の内容を公開したままにしない）。
 */
export async function upsertResource(db: Db, params: UpsertResourceParams): Promise<TenantResourceRow> {
  const result = await db.query(
    `INSERT INTO tenant_resources
       (id, tenant_id, title, description, storage_path, external_url, file_type,
        moderation_status, moderation_reason, rights_confirmed, is_published)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false)
     ON CONFLICT (tenant_id) DO UPDATE SET
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       storage_path = EXCLUDED.storage_path,
       external_url = EXCLUDED.external_url,
       file_type = EXCLUDED.file_type,
       moderation_status = EXCLUDED.moderation_status,
       moderation_reason = EXCLUDED.moderation_reason,
       rights_confirmed = EXCLUDED.rights_confirmed,
       is_published = false
     RETURNING ${ROW_COLUMNS}`,
    [
      params.id,
      params.tenantId,
      params.title,
      params.description ?? null,
      params.storagePath ?? null,
      params.externalUrl ?? null,
      params.fileType,
      params.moderationStatus,
      params.moderationReason ?? null,
      params.rightsConfirmed,
    ]
  );
  return result.rows[0] as TenantResourceRow;
}

/** テナントの資料を削除する。削除できたら true、元々存在しなければ false。 */
export async function deleteResource(db: Db, tenantId: string): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM tenant_resources WHERE tenant_id = $1`,
    [tenantId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * 公開状態を切り替える。公開(true)への遷移は、この1文のUPDATE自体が
 * moderation_status != 'rejected' をWHERE条件として持つことでアトミックに保証する
 * (routes.ts側の事前チェックだけに頼らない)。事前チェックと本更新の間に別リクエストの
 * 再アップロードでmoderation_statusが'rejected'に変わっていた場合、このUPDATEは
 * 0行にマッチしnullを返す(却下済み資料が公開されるTOCTOUを閉じる)。
 * 非公開化(false)はmoderation_statusに関わらず常に許可する。
 */
export async function setPublished(db: Db, tenantId: string, isPublished: boolean): Promise<TenantResourceRow | null> {
  const result = await db.query(
    `UPDATE tenant_resources SET is_published = $2
     WHERE tenant_id = $1 AND ($2 = false OR moderation_status != 'rejected')
     RETURNING ${ROW_COLUMNS}`,
    [tenantId, isPublished]
  );
  return (result.rows[0] as TenantResourceRow | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Supabase Storage: PDFバッファ → tenant-resources バケット
//
// migration_tenant_resources.sql の冒頭コメントの通り、バケット自体はこの機能では
// 作成しない（人間が事前に用意する前提）。avatar/routes.ts の ensureBucketExists()
// のような自動作成は行わない。
// ---------------------------------------------------------------------------

const RESOURCE_BUCKET = "tenant-resources";

/** PDFバッファを `${tenantId}/${resourceId}.pdf` にアップロードする。失敗時は null。 */
export async function uploadResourcePdfToStorage(
  buffer: Buffer,
  tenantId: string,
  resourceId: string
): Promise<string | null> {
  if (!supabaseAdmin) {
    logger.warn("[resources-storage] supabaseAdmin not initialized — upload skipped");
    return null;
  }

  const filePath = `${tenantId}/${resourceId}.pdf`;
  const { error } = await supabaseAdmin.storage
    .from(RESOURCE_BUCKET)
    .upload(filePath, buffer, { contentType: "application/pdf", upsert: true });

  if (error) {
    logger.warn("[resources-storage] upload failed:", error.message);
    return null;
  }

  return filePath;
}

/** storage_path から公開URLを取得する。supabaseAdmin未初期化時はnull。 */
export function getResourcePublicUrl(storagePath: string): string | null {
  if (!supabaseAdmin) return null;
  const { data } = supabaseAdmin.storage.from(RESOURCE_BUCKET).getPublicUrl(storagePath);
  return data?.publicUrl ?? null;
}
