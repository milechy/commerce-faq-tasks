// src/agent/judge/sweepCandidates.ts
// GID 1216970103691946 (PR-12): 離脱セッション自動評価スイープの候補選定クエリ。
//
// 純関数としてSQL/パラメータを組み立てるだけに責務を絞る(judgeEvaluator.ts の
// 評価ロジックとは混ぜない)。実行(pool.query)は呼び出し元(judgeSweepRunner.ts)
// が行う。

import { userSourceClause } from "../../api/admin/analytics/summaryQueries";

export interface SweepCandidatesQueryOptions {
  /** 段階開放のためのテナント許可リスト(JUDGE_SWEEP_TENANTS)。空配列なら候補0件。 */
  tenantIds: string[];
  /** 離脱判定: この間隔だけメッセージが無ければ「離脱」とみなす。既定30分。 */
  idleInterval?: string;
  /** 上限: この間隔より古いセッションはバックログに含めない(無限増殖防止)。既定7日。 */
  maxAgeInterval?: string;
  /**
   * 最低往復数のprefilter。message_count は chat_messages への INSERT と別
   * ステートメントで増分されるため、ここでは粗い足切りにのみ使う
   * (abResultsOutcomeSync.ts の TWO_PLUS_EXCHANGES_MESSAGE_COUNT と同基準=4)。
   * 実際の会話が2往復に満たない場合の最終判定は judgeEvaluator.ts の
   * SessionTooShortError に委ねる。
   */
  minMessageCount?: number;
  /** 1tickあたりの上限件数。starvation防止のため last_message_at ASC と併用する。 */
  limit?: number;
}

export interface SweepCandidateRow {
  tenant_id: string;
  session_id: string;
}

const DEFAULT_IDLE_INTERVAL = "30 minutes";
const DEFAULT_MAX_AGE_INTERVAL = "7 days";
const DEFAULT_MIN_MESSAGE_COUNT = 4;
const DEFAULT_LIMIT = 20;

/**
 * 離脱セッション自動評価スイープの候補を選ぶSQL/パラメータを組み立てる。
 * - 除外: conversation_evaluations に既に行があるセッション(NOT EXISTS、冪等性)
 * - 除外: is_escalated = true(有人対応中。judgePrompt.md は2者会話しか想定しない)
 * - 除外: userSourceClause('s')(e2e/未タグ付け。summaryQueries.ts の実装を再利用し、
 *   判定文字列をここに書き直さない)
 * - 順序: last_message_at ASC(古いセッションから処理し、starvationを作らない)
 *
 * tenantIds が空配列の場合、意図的に「候補0件」になるSQLを返す(呼び出し元が
 * 空配列チェックを別途実装する必要が無いようにする)。
 */
export function buildSweepCandidatesQuery(
  options: SweepCandidatesQueryOptions,
): { sql: string; params: unknown[] } {
  const idleInterval = options.idleInterval ?? DEFAULT_IDLE_INTERVAL;
  const maxAgeInterval = options.maxAgeInterval ?? DEFAULT_MAX_AGE_INTERVAL;
  const minMessageCount = options.minMessageCount ?? DEFAULT_MIN_MESSAGE_COUNT;
  const limit = options.limit ?? DEFAULT_LIMIT;

  const sql = `
    SELECT s.tenant_id, s.session_id
    FROM chat_sessions s
    WHERE s.tenant_id = ANY($1)
      AND s.last_message_at < NOW() - $2::interval
      AND s.last_message_at >= NOW() - $3::interval
      AND s.message_count >= $4
      AND s.is_escalated = false
      ${userSourceClause("s")}
      AND NOT EXISTS (
        SELECT 1 FROM conversation_evaluations ce
        WHERE ce.tenant_id = s.tenant_id AND ce.session_id = s.session_id
      )
    ORDER BY s.last_message_at ASC
    LIMIT $5
  `;

  return {
    sql,
    params: [options.tenantIds, idleInterval, maxAgeInterval, minMessageCount, limit],
  };
}
