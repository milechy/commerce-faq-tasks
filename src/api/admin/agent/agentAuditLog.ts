/**
 * 管理AIエージェント（/copilot-preview）経由のテナント設定変更を
 * tenant_settings_history へ記録する。
 *
 * 旧UI（PATCH /v1/admin/tenants/:id）は Phase72-A から同テーブルへ記録済みだが、
 * チャット経由の設定変更は記録されていなかった。新しいテーブルは作らず、
 * 既存の tenant_settings_history をそのまま再利用する。
 *
 * 制約:
 *   - fire-and-forget。失敗は logger.warn に落とすだけで呼び出し側へ投げない
 *     （監査記録の失敗がチャット応答を壊してはならない）
 *   - old_value は NULL 可。migration の COMMENT が
 *     「NULL = 新規設定 / 初期値不明」を正規の意味として定義しているため、
 *     変更前の値が手元にない場合は NULL をそのまま入れる（エラーではない）
 */

import type { Pool } from 'pg';
import { logger } from '../../../lib/logger';

export interface AgentSettingsChangeInput {
  tenantId: string;
  changedBy: string;
  fieldName: string;
  oldValue: unknown;
  newValue: unknown;
}

export async function recordAgentSettingsChange(db: Pool, input: AgentSettingsChangeInput): Promise<void> {
  try {
    await db.query(
      `INSERT INTO tenant_settings_history (tenant_id, changed_by, field_name, old_value, new_value)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
      [
        input.tenantId,
        input.changedBy,
        input.fieldName,
        // jsonb の 'null' リテラルではなく SQL NULL を入れる（「初期値不明」の意味を保つ）
        input.oldValue === null || input.oldValue === undefined ? null : JSON.stringify(input.oldValue),
        JSON.stringify(input.newValue),
      ],
    );
  } catch (err) {
    logger.warn('[agentAuditLog] tenant_settings_history INSERT failed', err);
  }
}
