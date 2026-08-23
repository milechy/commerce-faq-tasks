// src/agent/judge/judgeSweepRunner.ts
// GID 1216970103691946 (PR-12): 離脱セッションを自動評価する定期スイープ。
//
// 目的(R2): chat_sessions 1,041件に対し conversation_evaluations は累計4件・
// 直近30日0件。evaluateSession の呼び元がLangGraph経路と手動triggerのみで、
// 本番チャットから発火しない。ここでは第2のJudgeを作らず、既存の
// evaluateSession(judgeEvaluator.ts)をそのまま呼ぶ。
//
// 冪等性は既に4層ある(このスイープはNOT EXISTSを足すだけ):
//   1. uniq_conv_eval_session（本番適用済み）
//   2. judgeEvaluator.ts の事前EXISTS → Gemini課金前にSessionAlreadyEvaluatedError
//   3. ON CONFLICT (tenant_id, session_id) DO NOTHING + rowCount===0
//   4. このモジュール内のtickガード(isRunning)
//
// 単一実行の保証(CLAUDE.md 禁止30):
//   - intervalId の二重登録ガード(alertEngine.ts と同じ)
//   - isRunning による tick の重なりガード(1tickが20回のGemini呼び出しで
//     数分かかりうるため、既存のmetricsFlush/alertEngineには無い専用ガードを追加した)
//   - pg_try_advisory_lock は使わない(明示的な判断): 本番デプロイは PM2
//     instances:1 / exec_mode:fork の単一プロセスであり、プロセス間競合が
//     そもそも存在しない。advisory lock はこのリポジトリ初導入になり、
//     今は起きない問題への対処でしかないため見送る。将来レプリカ化する
//     場合に追加を検討する。

import pino from "pino";
import { getPool } from "../../lib/db";
import {
  evaluateSession,
  SessionNotFoundError,
  SessionTenantMismatchError,
  SessionTooShortError,
  SessionAlreadyEvaluatedError,
} from "./judgeEvaluator";
import { buildSweepCandidatesQuery, type SweepCandidateRow } from "./sweepCandidates";

const logger = pino({ name: "judge-sweep" });

/** 既定は r2c_default のみ(段階的開放。CLAUDE.md 禁止35と同じ理由)。 */
function resolveSweepTenants(): string[] {
  const raw = process.env.JUDGE_SWEEP_TENANTS;
  if (!raw || raw.trim() === "") return ["r2c_default"];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export interface JudgeSweepTickResult {
  candidates: number;
  succeeded: number;
  skipped: number;
  failed: number;
  hitLimit: boolean;
}

class JudgeSweepRunner {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  /**
   * 1tick分を実行する。呼び出し元(index.tsのsetInterval、またはテスト)から
   * 直接呼べるようpublicにしておく。
   */
  async tick(limit = 20): Promise<JudgeSweepTickResult> {
    if (this.isRunning) {
      logger.warn("[judgeSweep] previous tick still running, skipping this tick");
      return { candidates: 0, succeeded: 0, skipped: 0, failed: 0, hitLimit: false };
    }
    this.isRunning = true;

    try {
      const tenantIds = resolveSweepTenants();
      const pool = getPool();
      const { sql, params } = buildSweepCandidatesQuery({ tenantIds, limit });
      const result = await pool.query<SweepCandidateRow>(sql, params);
      const candidates = result.rows;

      let succeeded = 0;
      let skipped = 0;
      let failed = 0;

      for (const candidate of candidates) {
        try {
          // expectedTenantId を必ず渡す(judgeEvaluator.ts のセッション解決には
          // tenant述語が無いため、越境ミスマッチはここで検知して「失敗」ではなく
          // 「スキップ」として数える)。
          await evaluateSession(candidate.session_id, candidate.tenant_id);
          succeeded++;
        } catch (err) {
          if (
            err instanceof SessionTenantMismatchError ||
            err instanceof SessionAlreadyEvaluatedError ||
            err instanceof SessionNotFoundError ||
            err instanceof SessionTooShortError
          ) {
            // 既知の「評価対象外」状態。障害ではないため failed に数えない。
            // SessionTooShortError は既知の穴(未記録のため毎tick再選択されうる)
            // だが、対象セッション数が小さい間は許容範囲として運用で観察する。
            skipped++;
            continue;
          }
          failed++;
          logger.warn(
            { err, tenantId: candidate.tenant_id, sessionId: candidate.session_id },
            "[judgeSweep] evaluateSession failed (non-blocking, does not affect chat responses)",
          );
        }
      }

      const hitLimit = candidates.length >= limit;
      if (hitLimit) {
        // サイレント停止禁止(受け入れ条件): 上限に達しバックログが残っている
        // 可能性をここで可視化する。次tick(15分後)で続きを処理する。
        logger.warn(
          { limit, candidates: candidates.length },
          "[judgeSweep] hit per-tick candidate limit; backlog may remain and will be picked up next tick",
        );
      }

      logger.info(
        { tenantIds, candidates: candidates.length, succeeded, skipped, failed },
        "[judgeSweep] tick complete",
      );

      return { candidates: candidates.length, succeeded, skipped, failed, hitLimit };
    } finally {
      this.isRunning = false;
    }
  }

  start(intervalMs: number): void {
    if (this.intervalId !== null) return;
    logger.info({ intervalMs }, "[judgeSweep] started");
    this.intervalId = setInterval(() => {
      this.tick().catch((err: unknown) => {
        logger.error({ err }, "[judgeSweep] tick threw unexpectedly");
      });
    }, intervalMs);
    this.intervalId.unref?.();
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info("[judgeSweep] stopped");
    }
  }
}

export const judgeSweepRunner = new JudgeSweepRunner();
