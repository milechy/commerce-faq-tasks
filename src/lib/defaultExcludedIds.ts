// src/lib/defaultExcludedIds.ts
// Phase69-2: tenants.default_excluded_ids を DB から取得し、リクエスト側の excluded_ids とマージする。

import { pool } from './db';

/**
 * DB の tenants テーブルから default_excluded_ids を取得する。
 * DB 未接続・テナント不在・カラム NULL の場合は [] を返す（safe default）。
 */
export async function fetchDefaultExcludedIds(tenantId: string): Promise<string[]> {
  if (!tenantId || !pool) return [];
  try {
    const result = await pool.query<{ default_excluded_ids: string[] | null }>(
      'SELECT default_excluded_ids FROM tenants WHERE id = $1 LIMIT 1',
      [tenantId],
    );
    if (result.rows.length === 0) return [];
    return result.rows[0]!.default_excluded_ids ?? [];
  } catch {
    return [];
  }
}

/**
 * リクエスト側の excluded_ids と DB の default_excluded_ids をマージして返す。
 * 重複は除去する。どちらも空の場合は undefined を返す。
 */
export function mergeExcludedIds(
  requestIds: string[] | undefined | null,
  defaultIds: string[],
): string[] | undefined {
  const req = requestIds ?? [];
  if (defaultIds.length === 0 && req.length === 0) return undefined;
  if (defaultIds.length === 0) return req;
  const merged = Array.from(new Set([...req, ...defaultIds]));
  return merged;
}
