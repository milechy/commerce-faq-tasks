/**
 * MetricsCollector — pinoログイベントを受け取り、KPIカウンターを更新する
 *
 * 使い方:
 *   metricsCollector.recordConversationTerminal({ reason: "completed", tenantId: "t1" });
 *   metricsCollector.recordRagDuration({ phase: "search", tenantId: "t1", durationMs: 120 });
 *
 * 制約:
 *   - ragContent・書籍内容を引数に受け取らない
 *   - tenantId はミドルウェア由来のみ（PIIを含めない）
 */

import type {
  AvatarRequestStatus,
  ConversationTerminalReason,
  RagPhase,
} from "./kpiDefinitions";
import {
  activeSessionsGauge,
  avatarRequestsCounter,
  conversationTerminalCounter,
  httpErrorsCounter,
  killSwitchGauge,
  loopDetectedCounter,
  ragDurationHistogram,
} from "./promExporter";

// ---------------------------------------------------------------------------
// Input types (no ragContent / book content allowed)
// ---------------------------------------------------------------------------

export interface ConversationTerminalInput {
  reason: ConversationTerminalReason;
  tenantId: string;
}

export interface LoopDetectedInput {
  tenantId: string;
}

export interface AvatarRequestInput {
  status: AvatarRequestStatus;
  tenantId: string;
}

export interface RagDurationInput {
  phase: RagPhase;
  tenantId: string;
  durationMs: number;
}

export interface HttpErrorInput {
  statusCode: number;
  tenantId: string;
}

export interface KillSwitchInput {
  reason: string;
  active: boolean;
}

export interface SessionCountInput {
  tenantId: string;
  delta: 1 | -1;
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export const metricsCollector = {
  /** 会話がターミナル状態（完了 / ループ中断 / Kill Switch 等）に達した */
  recordConversationTerminal(input: ConversationTerminalInput): void {
    conversationTerminalCounter.inc({
      reason: input.reason,
      tenantId: input.tenantId,
    });
  },

  /** ダイアログループが検出された */
  recordLoopDetected(input: LoopDetectedInput): void {
    loopDetectedCounter.inc({ tenantId: input.tenantId });
  },

  /** アバターへのリクエスト（success / error / rate_limited） */
  recordAvatarRequest(input: AvatarRequestInput): void {
    avatarRequestsCounter.inc({
      status: input.status,
      tenantId: input.tenantId,
    });
  },

  /** RAG パイプラインの各フェーズの処理時間 */
  recordRagDuration(input: RagDurationInput): void {
    ragDurationHistogram.observe(
      { phase: input.phase, tenantId: input.tenantId },
      input.durationMs
    );
  },

  /** HTTP 4xx/5xx エラー */
  recordHttpError(input: HttpErrorInput): void {
    httpErrorsCounter.inc({
      statusCode: String(input.statusCode),
      tenantId: input.tenantId,
    });
  },

  /** Kill Switch の ON/OFF 切り替え */
  setKillSwitch(input: KillSwitchInput): void {
    killSwitchGauge.set({ reason: input.reason }, input.active ? 1 : 0);
  },

  /** アクティブセッション数の増減（セッション開始/終了時に呼ぶ） */
  adjustActiveSessions(input: SessionCountInput): void {
    if (input.delta === 1) {
      activeSessionsGauge.inc({ tenantId: input.tenantId });
    } else {
      activeSessionsGauge.dec({ tenantId: input.tenantId });
    }
  },
};
