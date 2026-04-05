// src/api/events/behaviorContext.ts
// Phase57: 訪問者の行動コンテキスト集計 + LLMプロンプト注入

import { getVisitorTemperature } from './temperatureScoring';
import { pool } from '../../lib/db';

export interface BehaviorContext {
  pageViewsSummary: string[];     // 閲覧ページURL（直近5件）
  maxScrollDepth: number;         // 最大スクロール深度%
  totalIdleTime: number;          // 合計滞在時間（秒）
  tempScore: number;              // 温度感スコア
  tempLevel: 'cold' | 'warm' | 'hot';
  referrerSummary: string;        // 流入元
  isReturnVisit: boolean;         // リピーターか
  productViews: string[];         // 閲覧商品名（最大3件）
}

/**
 * visitor_idの直近24時間の行動データを集計してBehaviorContextを返す。
 * visitorIdが空またはDB未接続の場合はnullを返す。
 */
export async function getBehaviorContext(
  tenantId: string,
  visitorId: string,
): Promise<BehaviorContext | null> {
  if (!visitorId || !pool) return null;

  try {
    // 直近24時間のイベントを集計
    const result = await pool.query(
      `SELECT event_type, event_data, page_url, referrer, created_at
       FROM behavioral_events
       WHERE tenant_id = $1 AND visitor_id = $2
         AND created_at >= NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC
       LIMIT 100`,
      [tenantId, visitorId],
    );

    if (result.rows.length === 0) return null;

    const events: Array<{
      event_type: string;
      event_data: Record<string, unknown> | null;
      page_url: string | null;
      referrer: string | null;
    }> = result.rows;

    // ページビュー集計（直近5件）
    const pageViews = events
      .filter((e) => e.event_type === 'page_view')
      .map((e) => e.page_url)
      .filter((u): u is string => !!u)
      .slice(0, 5);

    // スクロール深度最大値
    const scrollValues = events
      .filter((e) => e.event_type === 'scroll_depth')
      .map((e) => Number(e.event_data?.['depth_percent'] ?? 0))
      .filter((v) => !isNaN(v));
    const maxScrollDepth = scrollValues.length > 0 ? Math.max(0, ...scrollValues) : 0;

    // 滞在時間合計
    const totalIdleTime = events
      .filter((e) => e.event_type === 'idle_time')
      .reduce((sum, e) => sum + Number(e.event_data?.['seconds'] ?? 0), 0);

    // 商品閲覧（最大3件）
    const productViews = events
      .filter((e) => e.event_type === 'product_view')
      .map((e) => String(e.event_data?.['product_name'] ?? '').trim())
      .filter((n) => n.length > 0)
      .slice(0, 3);

    // リピーター判定（24時間前以前にもイベントがあるか）
    const olderEvents = await pool.query(
      `SELECT 1 FROM behavioral_events
       WHERE tenant_id = $1 AND visitor_id = $2
         AND created_at < NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [tenantId, visitorId],
    );
    const isReturnVisit = olderEvents.rows.length > 0;

    // 温度感算出
    const temp = await getVisitorTemperature(pool, tenantId, visitorId);

    // 流入元
    const referrer = events.find((e) => e.referrer)?.referrer ?? 'direct';

    return {
      pageViewsSummary: pageViews,
      maxScrollDepth,
      totalIdleTime,
      tempScore: temp.score,
      tempLevel: temp.level,
      referrerSummary: referrer,
      isReturnVisit,
      productViews,
    };
  } catch {
    return null;
  }
}

/**
 * BehaviorContextをLLMシステムプロンプト用テキストに変換する。
 * 書籍内容は含まない。PII（個人情報）も含めない。
 */
export function formatBehaviorContextForPrompt(ctx: BehaviorContext): string {
  const lines = [
    '## 訪問者の行動コンテキスト',
    `- 閲覧ページ: ${ctx.pageViewsSummary.length > 0 ? ctx.pageViewsSummary.join(', ') : 'なし'}`,
    `- スクロール: ${ctx.maxScrollDepth}%`,
    `- 滞在時間: ${ctx.totalIdleTime}秒`,
    `- 温度感スコア: ${ctx.tempScore}/100 (${ctx.tempLevel})`,
    `- 流入元: ${ctx.referrerSummary}`,
    `- 過去訪問: ${ctx.isReturnVisit ? 'リピーター' : '初回'}`,
  ];
  if (ctx.productViews.length > 0) {
    lines.push(`- 閲覧商品: ${ctx.productViews.join(', ')}`);
  }

  lines.push('');
  lines.push('## 推奨アプローチ');
  if (ctx.tempLevel === 'hot') {
    lines.push('温度感が高いお客様です。クロージング重視で、損失回避・希少性を活用してください。');
  } else if (ctx.tempLevel === 'warm') {
    lines.push('興味を持ち始めたお客様です。提案重視で、社会的証明・返報性を活用してください。');
  } else {
    lines.push('まだ情報収集段階のお客様です。信頼構築重視で、情報提供・共感を優先してください。');
  }

  return lines.join('\n');
}
