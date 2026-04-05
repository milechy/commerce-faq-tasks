// src/api/events/similarUserMatcher.ts
// Phase57: コンバージョン済みユーザーとの行動パターン類似度マッチング
// Phase58でconversion_attributionsテーブル追加予定。現在はchat_conversionイベントで代替。

import type { BehaviorContext } from './behaviorContext';

export interface SimilarPattern {
  conversionType: string;       // 'chat_conversion' | etc
  principlesUsed: string[];     // 使用された心理原則（chat_messages.metadataから）
  triggerType: string | null;   // 'proactive' | 'manual' | null
  similarity: number;           // 0-1
}

interface SessionBehaviorRow {
  session_id: string;
  max_scroll: number;
  total_idle: number;
  page_views: number;
  product_views: number;
  is_return: boolean;
  conversion_type: string;
  principles_used: string[];
  trigger_type: string | null;
}

function calculateSimilarity(a: BehaviorContext, b: SessionBehaviorRow): number {
  const vecA = [
    a.maxScrollDepth / 100,
    Math.min(a.totalIdleTime, 300) / 300,
    Math.min(a.pageViewsSummary.length, 10) / 10,
    Math.min(a.productViews.length, 5) / 5,
    a.isReturnVisit ? 1 : 0,
  ];
  const vecB = [
    Math.min(b.max_scroll, 100) / 100,
    Math.min(b.total_idle, 300) / 300,
    Math.min(b.page_views, 10) / 10,
    Math.min(b.product_views, 5) / 5,
    b.is_return ? 1 : 0,
  ];

  const dot = vecA.reduce((sum, v, i) => sum + v * (vecB[i] ?? 0), 0);
  const magA = Math.sqrt(vecA.reduce((sum, v) => sum + v * v, 0));
  const magB = Math.sqrt(vecB.reduce((sum, v) => sum + v * v, 0));

  return magA > 0 && magB > 0 ? dot / (magA * magB) : 0;
}

/**
 * コンバージョン済みセッションの行動パターンと現在の訪問者の類似度を計算し、
 * similarity > 0.5 の上位3件を返す。
 */
export async function findSimilarPatterns(
  db: { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> },
  tenantId: string,
  currentBehavior: BehaviorContext,
): Promise<SimilarPattern[]> {
  try {
    // コンバージョン済みセッションを取得（chat_conversionイベント）
    const converted = await db.query(
      `SELECT DISTINCT session_id
       FROM behavioral_events
       WHERE tenant_id = $1
         AND event_type = 'chat_conversion'
       LIMIT 50`,
      [tenantId],
    );

    if (converted.rows.length === 0) return [];

    const patterns: SimilarPattern[] = [];

    for (const row of converted.rows) {
      const sid: string = row.session_id;

      // セッションの行動データを集計
      const behaviorRows = await db.query(
        `SELECT
           COALESCE(MAX(CASE WHEN event_type='scroll_depth' THEN (event_data->>'depth_percent')::int ELSE 0 END), 0) AS max_scroll,
           COALESCE(SUM(CASE WHEN event_type='idle_time' THEN (event_data->>'seconds')::int ELSE 0 END), 0) AS total_idle,
           COALESCE(COUNT(CASE WHEN event_type='page_view' THEN 1 END), 0) AS page_views,
           COALESCE(COUNT(CASE WHEN event_type='product_view' THEN 1 END), 0) AS product_views
         FROM behavioral_events
         WHERE tenant_id = $1 AND session_id = $2`,
        [tenantId, sid],
      );
      const bRow = behaviorRows.rows[0] ?? {};

      // リピーター判定（visitor_idが2セッション以上持つか）
      const returnCheck = await db.query(
        `SELECT COUNT(DISTINCT s2.session_id) > 1 AS is_return
         FROM behavioral_events s1
         JOIN behavioral_events s2 ON s1.visitor_id = s2.visitor_id AND s1.tenant_id = s2.tenant_id
         WHERE s1.tenant_id = $1 AND s1.session_id = $2
         LIMIT 1`,
        [tenantId, sid],
      );
      const isReturn: boolean = returnCheck.rows[0]?.is_return ?? false;

      // chat_open イベントのtrigger情報
      const triggerRow = await db.query(
        `SELECT event_data->>'trigger' AS trigger_type
         FROM behavioral_events
         WHERE tenant_id = $1 AND session_id = $2 AND event_type = 'chat_open'
         LIMIT 1`,
        [tenantId, sid],
      );
      const triggerType: string | null = triggerRow.rows[0]?.trigger_type ?? null;

      const sessionBehavior: SessionBehaviorRow = {
        session_id: sid,
        max_scroll: Number(bRow.max_scroll ?? 0),
        total_idle: Number(bRow.total_idle ?? 0),
        page_views: Number(bRow.page_views ?? 0),
        product_views: Number(bRow.product_views ?? 0),
        is_return: isReturn,
        conversion_type: 'chat_conversion',
        principles_used: [],
        trigger_type: triggerType,
      };

      const similarity = calculateSimilarity(currentBehavior, sessionBehavior);
      if (similarity > 0.5) {
        patterns.push({
          conversionType: sessionBehavior.conversion_type,
          principlesUsed: sessionBehavior.principles_used,
          triggerType: sessionBehavior.trigger_type,
          similarity,
        });
      }
    }

    return patterns.sort((a, b) => b.similarity - a.similarity).slice(0, 3);
  } catch {
    return [];
  }
}
