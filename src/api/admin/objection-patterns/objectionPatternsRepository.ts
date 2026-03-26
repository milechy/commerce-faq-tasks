// src/api/admin/objection-patterns/objectionPatternsRepository.ts
// Phase46: 反論パターンリポジトリ（Stream A）

// @ts-ignore
import { Pool } from "pg";

let _pool: InstanceType<typeof Pool> | null = null;

function getPool(): InstanceType<typeof Pool> {
  if (!_pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    _pool = new Pool({ connectionString: url });
  }
  return _pool;
}

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface ObjectionPattern {
  id: number;
  tenant_id: string;
  pattern: string;
  response_template: string | null;
  success_rate: number;
  occurrence_count: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// 一覧取得（success_rate 降順）
// ---------------------------------------------------------------------------

export async function listObjectionPatterns(tenantId: string): Promise<ObjectionPattern[]> {
  const pool = getPool();
  const result = await pool.query<ObjectionPattern>(
    `SELECT id, tenant_id, pattern, response_template, success_rate, occurrence_count, created_at, updated_at
     FROM objection_patterns
     WHERE tenant_id = $1
     ORDER BY success_rate DESC, occurrence_count DESC`,
    [tenantId],
  );
  return result.rows.map((r: ObjectionPattern) => ({
    ...r,
    success_rate: parseFloat(String(r.success_rate)),
    occurrence_count: parseInt(String(r.occurrence_count), 10),
  }));
}

// ---------------------------------------------------------------------------
// 詳細取得
// ---------------------------------------------------------------------------

export async function getObjectionPattern(
  id: number,
  tenantId: string | undefined,
): Promise<ObjectionPattern | null> {
  const pool = getPool();
  const args: unknown[] = [id];
  let where = "WHERE id = $1";

  if (tenantId) {
    where += " AND tenant_id = $2";
    args.push(tenantId);
  }

  const result = await pool.query<ObjectionPattern>(
    `SELECT id, tenant_id, pattern, response_template, success_rate, occurrence_count, created_at, updated_at
     FROM objection_patterns ${where}`,
    args,
  );
  if (!result.rows[0]) return null;
  const r = result.rows[0];
  return {
    ...r,
    success_rate: parseFloat(String(r.success_rate)),
    occurrence_count: parseInt(String(r.occurrence_count), 10),
  };
}

// ---------------------------------------------------------------------------
// 削除
// ---------------------------------------------------------------------------

export async function deleteObjectionPattern(
  id: number,
  tenantId: string | undefined,
): Promise<boolean> {
  const pool = getPool();
  let result;
  if (tenantId) {
    result = await pool.query(
      "DELETE FROM objection_patterns WHERE id = $1 AND tenant_id = $2",
      [id, tenantId],
    );
  } else {
    result = await pool.query(
      "DELETE FROM objection_patterns WHERE id = $1",
      [id],
    );
  }
  return (result.rowCount ?? 0) > 0;
}
