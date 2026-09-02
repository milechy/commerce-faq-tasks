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
import { countFaqIndexMismatch } from "../../../lib/knowledge/faqIndexSync";

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
  /**
   * faq_docs / faq_embeddings / ES の3ストア突合(2026-08-25 ナレッジ配線是正P7)。
   * テナント指定が無い(cross-tenant view)ときは対象を特定できないため null。
   * 新テーブルは作らず、毎回ライブ計算する(CLAUDE.md 禁止32)。
   */
  knowledgeIndexDrift: KnowledgeIndexDrift | null;
  /**
   * 消費者の回答評価(👍👎、2026-08-25 ナレッジ配線是正P14)。母数が小さくても
   * 生の件数は誤解を招かないため率ではなくカウントで出す(禁止34は比率の話)。
   */
  answerFeedback: AnswerFeedbackCounts;
}

export interface AnswerFeedbackCounts {
  upCount: number;
  downCount: number;
}

export interface KnowledgeIndexDrift {
  dbPublishedCount: number;
  embeddingMissingCount: number;
  orphanEmbeddingCount: number;
  /** ES_URL未設定・クエリ失敗時は null(「ズレ0」と誤読されないようにする) */
  esCount: number | null;
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
  /**
   * LB-9: 「AIが割り込んで開いた(先回り声がけ)」と「訪問者が自分で開いた」は
   * 応答率の意味が全く違うのに、上記の visitorsOpened/dropoffRate は両者を
   * 同一視して合算していた。behavioral_events.event_data.trigger='proactive' の
   * 有無でopened/conversedをそれぞれ独立に数え直す(1訪問者が両方の開き方を
   * した場合は両方の集計に重複して入りうる。「片方だけした人」に絞る集計では
   * ないため、proactive.visitorsOpened + manual.visitorsOpened は
   * 必ずしも visitorsOpened と一致しない)。
   */
  proactive: ChatOpenDropoffByTrigger;
  manual: ChatOpenDropoffByTrigger;
  /**
   * GID 1218086189953625: 分母(chat_open)から除外した「不明(source未記録)」の訪問者数。
   * behavioral_events.source は 2026-08-29 の後付け列で過去データは NULL のまま
   * (推定で埋めない、migration_behavioral_events_source.sql 参照)。黙って除外すると
   * 「visitorsOpened が急に減った」という誤解を生むため、除外した件数を必ず併記する。
   */
  unknownSourceVisitorCount: number;
}

export interface ChatOpenDropoffByTrigger {
  visitorsOpened: number;
  visitorsConversed: number;
  dropoffRate: number | null;
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
  const dropoffResult = await db.query<{
    opened: string; conversed: string;
    opened_proactive: string; conversed_proactive: string;
    opened_manual: string; conversed_manual: string;
    opened_unknown_source: string;
  }>(
    `WITH tracking AS (
       SELECT MIN(s2.started_at) AS since FROM chat_sessions s2
       WHERE s2.visitor_id IS NOT NULL ${tenantId ? "AND s2.tenant_id = $2" : ""}
     ),
     -- LB-9: 1visitor_idが複数回chat_openを起こしうるため、visitor単位に畳んでから
     -- 「proactive発火を1回でも含むか」「能動クリックを1回でも含むか」を bool_or で持つ。
     -- 両方に該当する訪問者は両方の集計に入る(片方だけに絞る設計ではない。
     -- ChatOpenDropoffのコメント参照)。
     -- GID 1218086189953625: 分子(chat_sessions)は source='user' で浄化済みなのに
     -- 分母(chat_open)がノーフィルタだと比率が意味を持たない。behavioral_events.source
     -- で同じ基準を適用する(source IS NULL = 判定不能な過去データは別途unknown_visitorsで数える)。
     opened_visitors AS (
       SELECT b.visitor_id,
              bool_or(b.event_data->>'trigger' = 'proactive') AS has_proactive,
              bool_or(b.event_data->>'trigger' IS DISTINCT FROM 'proactive') AS has_manual
         FROM behavioral_events b, tracking t
        WHERE b.event_type = 'chat_open'
          AND b.source = 'user'
          AND t.since IS NOT NULL
          AND b.created_at >= GREATEST(t.since, NOW() - $1::interval)
          ${beTenantClause}
        GROUP BY b.visitor_id
     ),
     unknown_source_visitors AS (
       SELECT DISTINCT b.visitor_id
         FROM behavioral_events b, tracking t
        WHERE b.event_type = 'chat_open'
          AND b.source IS NULL
          AND t.since IS NOT NULL
          AND b.created_at >= GREATEST(t.since, NOW() - $1::interval)
          ${beTenantClause}
     ),
     conversed_visitors AS (
       SELECT DISTINCT s.visitor_id
         FROM chat_sessions s, tracking t
        WHERE s.visitor_id IS NOT NULL
          AND t.since IS NOT NULL
          AND s.started_at >= GREATEST(t.since, NOW() - $1::interval)
          AND s.message_count > 0
          ${tenantClause}
          ${userSourceClause("s")}
     )
     SELECT
       (SELECT COUNT(*) FROM opened_visitors) AS opened,
       (SELECT COUNT(*) FROM conversed_visitors) AS conversed,
       (SELECT COUNT(*) FROM opened_visitors WHERE has_proactive) AS opened_proactive,
       (SELECT COUNT(*) FROM opened_visitors ov JOIN conversed_visitors cv
          ON cv.visitor_id = ov.visitor_id WHERE ov.has_proactive) AS conversed_proactive,
       (SELECT COUNT(*) FROM opened_visitors WHERE has_manual) AS opened_manual,
       (SELECT COUNT(*) FROM opened_visitors ov JOIN conversed_visitors cv
          ON cv.visitor_id = ov.visitor_id WHERE ov.has_manual) AS conversed_manual,
       (SELECT COUNT(*) FROM unknown_source_visitors) AS opened_unknown_source`,
    params,
  );
  const dropoffRow = dropoffResult.rows[0];
  const visitorsOpened = parseInt(dropoffRow?.opened ?? "0", 10);
  const visitorsConversed = parseInt(dropoffRow?.conversed ?? "0", 10);

  const rateForTrigger = (opened: number, conversed: number): ChatOpenDropoffByTrigger => ({
    visitorsOpened: opened,
    visitorsConversed: conversed,
    dropoffRate: opened >= MIN_VISITORS_FOR_RATE ? Math.round(((opened - conversed) / opened) * 1000) / 10 : null,
  });

  const chatOpenDropoff: ChatOpenDropoff = {
    trackingSince,
    visitorsOpened,
    visitorsConversed,
    dropoffRate:
      visitorsOpened >= MIN_VISITORS_FOR_RATE
        ? Math.round(((visitorsOpened - visitorsConversed) / visitorsOpened) * 1000) / 10
        : null,
    sessionCoverage,
    proactive: rateForTrigger(
      parseInt(dropoffRow?.opened_proactive ?? "0", 10),
      parseInt(dropoffRow?.conversed_proactive ?? "0", 10),
    ),
    manual: rateForTrigger(
      parseInt(dropoffRow?.opened_manual ?? "0", 10),
      parseInt(dropoffRow?.conversed_manual ?? "0", 10),
    ),
    unknownSourceVisitorCount: parseInt(dropoffRow?.opened_unknown_source ?? "0", 10),
  };

  const knowledgeIndexDrift = tenantId
    ? await countFaqIndexMismatch(db as unknown as Pool, tenantId)
        .then((r) => ({
          dbPublishedCount: r.dbCount,
          embeddingMissingCount: r.embeddingMissingCount,
          orphanEmbeddingCount: r.orphanEmbeddingCount,
          esCount: r.esCount === -1 ? null : r.esCount,
        }))
        .catch(() => null)
    : null;

  // ナレッジ配線是正P14: answer_feedback(👍👎)の生件数。event_data.rating は
  // 'up' | 'down' の2値のみ想定(不明値はどちらにも数えない)。
  const feedbackResult = await db.query<{ up: string; down: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE b.event_data->>'rating' = 'up') AS up,
       COUNT(*) FILTER (WHERE b.event_data->>'rating' = 'down') AS down
     FROM behavioral_events b
     WHERE b.event_type = 'answer_feedback'
       AND b.created_at >= NOW() - $1::interval ${beTenantClause}`,
    params,
  );
  const answerFeedback: AnswerFeedbackCounts = {
    upCount: parseInt(feedbackResult.rows[0]?.up ?? "0", 10),
    downCount: parseInt(feedbackResult.rows[0]?.down ?? "0", 10),
  };

  return {
    sourceBreakdown,
    emptySessionCount,
    cvSessionLinkRate,
    outcomeRecordRate,
    validUserSessionCount,
    chatOpenDropoff,
    knowledgeIndexDrift,
    answerFeedback,
  };
}
