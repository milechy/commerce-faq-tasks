// src/agent/openclaw/workspaceCache.ts
// Phase47-C: テナント単位の WorkspaceFiles メモリキャッシュ
//
// system_prompt は tenants テーブルから取得し buildWorkspaceFiles に渡す。
// 管理画面で system_prompt 更新時は invalidateWorkspaceCache で無効化する。

import pino from "pino";

import { getPool } from "../../lib/db";

import { isOpenClawEnabled } from "./featureFlag";
import { buildWorkspaceFiles, type WorkspaceFiles } from "./workspaceAdapter";

const logger = pino();
const workspaceCache = new Map<string, WorkspaceFiles>();

/** テナントの WorkspaceFiles を取得（キャッシュ優先）。Flag オフ時は DB 照会せず null。 */
export async function getOrBuildWorkspace(
  tenantId: string,
): Promise<WorkspaceFiles | null> {
  if (!isOpenClawEnabled(tenantId)) return null;

  const cached = workspaceCache.get(tenantId);
  if (cached) return cached;

  const pool = getPool();
  const result = await pool.query<{ system_prompt: string | null }>(
    "SELECT system_prompt FROM tenants WHERE id = $1",
    [tenantId],
  );
  const systemPrompt = result.rows[0]?.system_prompt ?? "";

  const ws = buildWorkspaceFiles(tenantId, systemPrompt);
  if (ws) {
    workspaceCache.set(tenantId, ws);
    logger.debug({ tenantId }, "openclaw.workspace.built"); // 内容はログに出さない
  }
  return ws;
}

/** キャッシュ無効化（tenantId 省略時は全件）。system_prompt 更新時に呼ぶ。 */
export function invalidateWorkspaceCache(tenantId?: string): void {
  if (tenantId) workspaceCache.delete(tenantId);
  else workspaceCache.clear();
}
