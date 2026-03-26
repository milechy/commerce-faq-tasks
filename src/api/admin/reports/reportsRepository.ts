// src/api/admin/reports/reportsRepository.ts
// Phase46: 週次レポートリポジトリ（Stream A）

import { getPool } from "../../../lib/db";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface WeeklyReport {
  id: number;
  tenant_id: string;
  title: string | null;
  content: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// 週次レポート一覧（最新順）
// ---------------------------------------------------------------------------

export async function listReports(tenantId: string): Promise<WeeklyReport[]> {
  const pool = getPool();
  const result = await pool.query<WeeklyReport>(
    `SELECT id, tenant_id, title, content, read_at, created_at
     FROM weekly_reports
     WHERE tenant_id = $1
     ORDER BY created_at DESC`,
    [tenantId],
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// レポート詳細
// ---------------------------------------------------------------------------

export async function getReport(
  id: number,
  tenantId: string | undefined,
): Promise<WeeklyReport | null> {
  const pool = getPool();
  const args: unknown[] = [id];
  let where = "WHERE id = $1";

  if (tenantId) {
    where += " AND tenant_id = $2";
    args.push(tenantId);
  }

  const result = await pool.query<WeeklyReport>(
    `SELECT id, tenant_id, title, content, read_at, created_at
     FROM weekly_reports ${where}`,
    args,
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// 未読レポート数（read_at IS NULL）
// ---------------------------------------------------------------------------

export async function getUnreadCount(tenantId: string): Promise<number> {
  const pool = getPool();
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM weekly_reports WHERE tenant_id = $1 AND read_at IS NULL`,
    [tenantId],
  );
  return parseInt(result.rows[0]?.count ?? "0", 10);
}
