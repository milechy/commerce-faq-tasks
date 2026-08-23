// src/api/admin/analytics/measurementHealth.ts
// GID 1216970103691946 (PR-7): 計測ヘルス — 「何を直しても効果を測れない」状態を
// 脱したことを1画面で確認するための指標群。
//
// summaryQueries.ts は「テナント向け分析」の責務(会話数・スコア・KPI等)を持つが、
// これは「計測パイプライン自体が機能しているか」という別の関心事のため、
// このファイルに分離する。
//
// CLAUDE.md 禁止34: 母数不足のときに 0 や矢印を出すと誤った自信を与える。
// rate系の指標は total=0 のとき null を返し、呼び出し元は「判定に足りない」を表示する。

import type { Pool } from "pg";
import { periodToInterval, userSourceClause } from "./summaryQueries";
import { AUTO_OUTCOME_RECORDED_BY } from "../chat-history/chatHistoryRepository";

type Db = Pick<Pool, "query">;

export interface SourceBreakdownRow {
  source: string; // '(null)' は metadata.source 未設定を表す文字列(実データの'null'文字列と区別するため)
  count: number;
}

export interface RateMetric {
  numerator: number;
  denominator: number;
  /** denominator=0 のとき null(母数不足で判定できない) */
  rate: number | null;
}

export interface MeasurementHealthResponse {
  /** metadata.source別セッション数(e2e/null/user等、フィルタしない生の内訳) */
  sourceBreakdown: SourceBreakdownRow[];
  /** message_count=0 の空セッション数(PR-2で根治した不具合の再発検知) */
  emptySessionCount: number;
  /** CVがchat_sessions.idに結合できた率(PR-5で対応) */
  cvSessionLinkRate: RateMetric;
  /** outcomeが記録されたセッションの率、うち自動記録件数(PR-6で対応) */
  outcomeRecordRate: RateMetric & { autoRecorded: number };
  /** 実ユーザー(source='user')かつメッセージがある(message_count>0)有効セッション数。
   *  以降のPRの判定に使える母数そのもの。 */
  validUserSessionCount: number;
}

function toRateMetric(numerator: number, denominator: number): RateMetric {
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null,
  };
}

export async function fetchMeasurementHealth(
  db: Db,
  tenantId: string | null,
  period: string,
): Promise<MeasurementHealthResponse> {
  const interval = periodToInterval(period);
  const tenantClause = tenantId ? "AND s.tenant_id = $2" : "";
  const params: (string | number)[] = [interval];
  if (tenantId) params.push(tenantId);

  const sourceResult = await db.query<{ source: string; count: string }>(
    `SELECT COALESCE(s.metadata->>'source', '(null)') AS source, COUNT(*) AS count
     FROM chat_sessions s
     WHERE s.started_at >= NOW() - $1::interval ${tenantClause}
     GROUP BY COALESCE(s.metadata->>'source', '(null)')
     ORDER BY count DESC`,
    params,
  );
  const sourceBreakdown: SourceBreakdownRow[] = sourceResult.rows.map((row) => ({
    source: row.source,
    count: parseInt(row.count, 10),
  }));

  const emptyResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM chat_sessions s
     WHERE s.started_at >= NOW() - $1::interval ${tenantClause} AND s.message_count = 0`,
    params,
  );
  const emptySessionCount = parseInt(emptyResult.rows[0]?.count ?? "0", 10);

  const cvTenantClause = tenantId ? "AND tenant_id = $2" : "";
  const cvResult = await db.query<{ linked: string; total: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE session_id IS NOT NULL) AS linked,
       COUNT(*) AS total
     FROM conversion_attributions
     WHERE created_at >= NOW() - $1::interval ${cvTenantClause}`,
    params,
  );
  const cvSessionLinkRate = toRateMetric(
    parseInt(cvResult.rows[0]?.linked ?? "0", 10),
    parseInt(cvResult.rows[0]?.total ?? "0", 10),
  );

  // outcome記録率・実ユーザー有効セッション数は、実ユーザー(source='user')の
  // セッションのみを対象にする(e2eの記録有無は「計測が効いているか」の判定に無意味なため)。
  const outcomeResult = await db.query<{ recorded: string; auto_recorded: string; total: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE s.outcome IS NOT NULL) AS recorded,
       COUNT(*) FILTER (WHERE s.outcome_recorded_by = '${AUTO_OUTCOME_RECORDED_BY}') AS auto_recorded,
       COUNT(*) AS total
     FROM chat_sessions s
     WHERE s.started_at >= NOW() - $1::interval ${tenantClause} ${userSourceClause("s")}`,
    params,
  );
  const outcomeRow = outcomeResult.rows[0];
  const outcomeRecordRate = {
    ...toRateMetric(
      parseInt(outcomeRow?.recorded ?? "0", 10),
      parseInt(outcomeRow?.total ?? "0", 10),
    ),
    autoRecorded: parseInt(outcomeRow?.auto_recorded ?? "0", 10),
  };

  const validResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM chat_sessions s
     WHERE s.started_at >= NOW() - $1::interval ${tenantClause}
       AND s.message_count > 0
       ${userSourceClause("s")}`,
    params,
  );
  const validUserSessionCount = parseInt(validResult.rows[0]?.count ?? "0", 10);

  return {
    sourceBreakdown,
    emptySessionCount,
    cvSessionLinkRate,
    outcomeRecordRate,
    validUserSessionCount,
  };
}
