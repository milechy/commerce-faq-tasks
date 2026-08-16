// src/lib/sai/saiTaskRegistry.ts
// Sai代行タスクの所有権レジストリ。詳細は migration_sai_tasks.sql を参照。
//
// 背景: get_sai_task_status は LLM/ユーザーが渡した task_id を所有権照合なしで
// Sai VPS に転送していた。tenantId は同じスコープにあるのに使われておらず、
// 他テナントのタスクの status/steps/outcome/last_action が読め、さらに
// usage_logs.request_id がグローバル UNIQUE + ON CONFLICT DO NOTHING のため
// 「先に叩いたテナントに課金され、正当な計上は黙って消える」状態だった。
//
// db は必ず呼び出し元から注入する（getPool() を内部で呼ぶとテストのモックPoolと
// 食い違う — CLAUDE.md の既知の罠）。

import type { Pool } from 'pg';
import { logger } from '../logger';

export interface RecordSaiTaskParams {
  taskId: string;
  tenantId: string;
  description: string;
  orderId?: string | null;
  requestedBy?: string | null;
}

/**
 * task_id の所有権解決結果。
 *
 * 「不存在」と「照合できない」を同じ値で表現しない（CLAUDE.md 禁止事項20）。
 * unavailable は migration 未適用・DB障害であり、呼び出し元は fail-closed で
 * 拒否しつつ、ユーザーには不存在とは別の文言を出す必要がある。
 */
export type SaiTaskOwnerLookup =
  | { status: 'ok'; tenantId: string }
  | { status: 'not_found' }
  | { status: 'unavailable' };

/**
 * Sai へ投入したタスクの所有権を記録する。
 *
 * 投入(submitSaiTask)は既に成功している前提で呼ばれるため、記録の失敗で例外を
 * 投げない。ただし「記録に失敗したのに処理が進んだと表示しない」ため false を返し、
 * 呼び出し元はユーザーに進捗確認ができない旨を伝えること。
 */
export async function recordSaiTask(db: Pool, params: RecordSaiTaskParams): Promise<boolean> {
  try {
    await db.query(
      `INSERT INTO sai_tasks (task_id, tenant_id, order_id, description, requested_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (task_id) DO NOTHING`,
      [
        params.taskId,
        params.tenantId,
        params.orderId ?? null,
        params.description,
        params.requestedBy ?? null,
      ],
    );
    return true;
  } catch (err: any) {
    if (err?.code === '42P01') {
      logger.warn(
        { taskId: params.taskId },
        '[saiTaskRegistry] sai_tasks not migrated yet — task ownership will not be verifiable',
      );
    } else {
      logger.warn({ err, taskId: params.taskId }, '[saiTaskRegistry] recordSaiTask failed');
    }
    return false;
  }
}

/** task_id を依頼元テナントに解決する。照合できない場合は not_found と区別して unavailable を返す。 */
export async function resolveSaiTaskTenant(db: Pool, taskId: string): Promise<SaiTaskOwnerLookup> {
  try {
    const result = await db.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM sai_tasks WHERE task_id = $1`,
      [taskId],
    );
    const row = result.rows[0];
    if (!row) return { status: 'not_found' };
    return { status: 'ok', tenantId: row.tenant_id };
  } catch (err: any) {
    if (err?.code === '42P01') {
      logger.warn('[saiTaskRegistry] sai_tasks not migrated yet — denying task status lookup (fail-closed)');
    } else {
      logger.warn({ err }, '[saiTaskRegistry] resolveSaiTaskTenant failed');
    }
    return { status: 'unavailable' };
  }
}
