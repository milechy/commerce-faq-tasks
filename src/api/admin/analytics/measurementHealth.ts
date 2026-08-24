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
  /** チャットを開いたのに会話しなかった割合。G5(1,516回開かれて13会話)の解明用。 */
  chatOpenDropoff: ChatOpenDropoff;
}

/**
 * 「開いたが話さない」率。
 *
 * **visitor_id の記録が始まる前のセッションは永久に結合できない**ため、
 * 期間全体で率を出すと「0%が話した」という誤った数字になる。
 * そこで母数の開始点を trackingSince(= visitor_id を持つ最古のセッション)に切り、
 * それ以前は集計対象から外す。trackingSince が null なら記録が一度も無い状態。
 */
export interface ChatOpenDropoff {
  /** 集計の起点。null なら visitor_id を持つセッションが1件も無い。 */
  trackingSince: string | null;
  /** チャットを開いた訪問者数(重複排除)。 */
  visitorsOpened: number;
  /** そのうち実際に会話した訪問者数(実ユーザー・メッセージあり)。 */
  visitorsConversed: number;
  /** 離脱率。母数が MIN_VISITORS_FOR_RATE 未満なら null(数値を出さない)。 */
  dropoffRate: number | null;
  /** visitor_id が付いたセッションの割合。この指標自体の信頼度を示す。 */
  sessionCoverage: RateMetric;
}

/**
 * 率を出すのに必要な最低訪問者数。これ未満では比率を出さず「判定に足りない」を出す
 * (CLAUDE.md 禁止34: 母数不足のときに数値を出さない)。
 */
export const MIN_VISITORS_FOR_RATE = 30;

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

  // G5: チャットは開かれているのに会話にならない乖離を説明する。
  // visitor_id は widget の localStorage 由来でテナントを跨いで衝突しうるため、
  // 必ず (tenant_id, visitor_id) の複合で扱う(migration_visitor_id.sql の警告)。
  const coverageResult = await db.query<{ since: string | null; with_vid: string; total: string }>(
    `SELECT MIN(s.started_at) FILTER (WHERE s.visitor_id IS NOT NULL) AS since,
            COUNT(*) FILTER (WHERE s.visitor_id IS NOT NULL) AS with_vid,
            COUNT(*) AS total
     FROM chat_sessions s
     WHERE s.started_at >= NOW() - $1::interval ${tenantClause}`,
    params,
  );
  const trackingSince = coverageResult.rows[0]?.since ?? null;
  const sessionCoverage = toRateMetric(
    parseInt(coverageResult.rows[0]?.with_vid ?? "0", 10),
    parseInt(coverageResult.rows[0]?.total ?? "0", 10),
  );

  // trackingSince より前は結合しようがないので、母数の開始点をそこに切る。
  // GREATEST で期間指定とも突き合わせる。
  const beTenantClause = tenantId ? "AND b.tenant_id = $2" : "";
  const dropoffResult = await db.query<{ opened: string; conversed: string }>(
    `WITH tracking AS (
       SELECT MIN(s2.started_at) AS since FROM chat_sessions s2
       WHERE s2.visitor_id IS NOT NULL ${tenantId ? "AND s2.tenant_id = $2" : ""}
     )
     SELECT
       (SELECT COUNT(DISTINCT b.visitor_id)
          FROM behavioral_events b, tracking t
         WHERE b.event_type = 'chat_open'
           AND t.since IS NOT NULL
           AND b.created_at >= GREATEST(t.since, NOW() - $1::interval)
           ${beTenantClause}) AS opened,
       (SELECT COUNT(DISTINCT s.visitor_id)
          FROM chat_sessions s, tracking t
         WHERE s.visitor_id IS NOT NULL
           AND t.since IS NOT NULL
           AND s.started_at >= GREATEST(t.since, NOW() - $1::interval)
           AND s.message_count > 0
           ${tenantClause}
           ${userSourceClause("s")}) AS conversed`,
    params,
  );
  const visitorsOpened = parseInt(dropoffResult.rows[0]?.opened ?? "0", 10);
  const visitorsConversed = parseInt(dropoffResult.rows[0]?.conversed ?? "0", 10);
  const chatOpenDropoff: ChatOpenDropoff = {
    trackingSince,
    visitorsOpened,
    visitorsConversed,
    dropoffRate:
      visitorsOpened >= MIN_VISITORS_FOR_RATE
        ? Math.round(((visitorsOpened - visitorsConversed) / visitorsOpened) * 1000) / 10
        : null,
    sessionCoverage,
  };

  return {
    sourceBreakdown,
    emptySessionCount,
    cvSessionLinkRate,
    outcomeRecordRate,
    validUserSessionCount,
    chatOpenDropoff,
  };
}
