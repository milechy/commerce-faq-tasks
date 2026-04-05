// src/api/events/temperatureScoring.ts
// Phase56: 訪問者温度感スコアリング（LLM不使用）

export interface TemperatureContext {
  scrollDepthMax: number;  // 0-100
  idleTimeTotal: number;   // seconds
  pageViews: number;
  productViews: number;
  isReturnVisit: boolean;
}

export interface TemperatureResult {
  score: number;           // 0-100
  level: 'cold' | 'warm' | 'hot';
}

/**
 * 訪問者の行動コンテキストから温度感スコアを算出する。
 *
 * スコア内訳:
 *   scroll_depth (0-100) → 0-20点
 *   idle_time    (0-300s) → 0-20点
 *   page_views   (1-10+) → 0-20点
 *   product_views (0-5+) → 0-20点
 *   return_visit         → 0 or 20点
 */
export function calculateTemperature(ctx: TemperatureContext): TemperatureResult {
  let score = 0;

  // scroll_depth: 0-100 → 0-20点 (5点/20%)
  score += Math.min(20, Math.round(ctx.scrollDepthMax / 5));

  // idle_time: 0-300sec → 0-20点 (1点/15秒)
  score += Math.min(20, Math.round(ctx.idleTimeTotal / 15));

  // page_views: 1-10+ → 0-20点 (2点/ページ、初回ページは0点)
  score += Math.min(20, Math.max(0, (ctx.pageViews - 1) * 2));

  // product_views: 0-5+ → 0-20点 (4点/商品)
  score += Math.min(20, ctx.productViews * 4);

  // return_visit: 0 or 20点
  score += ctx.isReturnVisit ? 20 : 0;

  score = Math.min(100, Math.max(0, score));

  const level: TemperatureResult['level'] =
    score >= 70 ? 'hot' : score >= 30 ? 'warm' : 'cold';

  return { score, level };
}

/**
 * behavioral_eventsテーブルから訪問者の温度感を算出する（Phase57でLLM統合予定）。
 */
export async function getVisitorTemperature(
  db: { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> },
  tenantId: string,
  visitorId: string,
): Promise<TemperatureResult> {
  const result = await db.query(
    `SELECT
       event_type,
       event_data
     FROM behavioral_events
     WHERE tenant_id = $1 AND visitor_id = $2
     ORDER BY created_at DESC
     LIMIT 200`,
    [tenantId, visitorId],
  );

  let scrollDepthMax = 0;
  let idleTimeTotal = 0;
  let pageViews = 0;
  let productViews = 0;

  for (const row of result.rows) {
    const data = row.event_data ?? {};
    switch (row.event_type) {
      case 'scroll_depth':
        if (typeof data.depth_percent === 'number') {
          scrollDepthMax = Math.max(scrollDepthMax, data.depth_percent);
        }
        break;
      case 'idle_time':
        if (typeof data.seconds === 'number') {
          idleTimeTotal += data.seconds;
        }
        break;
      case 'page_view':
        pageViews++;
        break;
      case 'product_view':
        productViews++;
        break;
    }
  }

  // 再訪問判定: 同一visitor_idが複数セッションを持つかどうか
  const sessionResult = await db.query(
    `SELECT COUNT(DISTINCT session_id) AS cnt
     FROM behavioral_events
     WHERE tenant_id = $1 AND visitor_id = $2`,
    [tenantId, visitorId],
  );
  const isReturnVisit = Number(sessionResult.rows[0]?.cnt ?? 0) > 1;

  return calculateTemperature({
    scrollDepthMax,
    idleTimeTotal,
    pageViews,
    productViews,
    isReturnVisit,
  });
}
