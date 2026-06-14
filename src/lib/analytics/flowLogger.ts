// src/lib/analytics/flowLogger.ts
// Phase72-C: State Machine 遷移ログの非同期記録（fire-and-forget）
// usageTracker.ts の setImmediate パターンを踏襲

import type pino from 'pino';

export interface LogFlowTransitionParams {
  tenantId: string;
  sessionId: string;
  fromState: string | undefined;
  toState: string;
  turnIndex: number;
  metadata?: Record<string, unknown>;
}

let _pool: any | null = null;
let _logger: pino.Logger | null = null;

export function initFlowLogger(pool: any, logger: pino.Logger): void {
  _pool = pool;
  _logger = logger;
}

/**
 * フロー遷移を DB に非同期で記録する（fire-and-forget）。
 * setImmediate で遅延実行するため API レスポンス速度に影響しない。
 */
export function logFlowTransition(params: LogFlowTransitionParams): void {
  setImmediate(() => {
    void _insertFlowLog(params);
  });
}

async function _insertFlowLog(params: LogFlowTransitionParams): Promise<void> {
  if (!_pool) {
    _logger?.warn(
      { sessionId: params.sessionId },
      '[flowLogger] pool not initialized, skipping',
    );
    return;
  }

  const { tenantId, sessionId, fromState, toState, turnIndex, metadata } = params;

  try {
    await _pool.query(
      `INSERT INTO conversation_flow_logs
         (tenant_id, session_id, from_state, to_state, turn_index, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        tenantId,
        sessionId,
        fromState ?? null,
        toState,
        turnIndex,
        metadata ? JSON.stringify(metadata) : '{}',
      ],
    );
    _logger?.debug(
      { tenantId, sessionId, fromState, toState, turnIndex },
      '[flowLogger] logged',
    );
  } catch (err) {
    // DB エラーはログするが API レスポンスには影響させない
    _logger?.error({ err, tenantId, sessionId }, '[flowLogger] db insert failed');
  }
}
