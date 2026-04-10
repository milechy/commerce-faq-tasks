// src/lib/crossTenantContext.ts
// Phase60-B: クロステナント匿名集計コンテキスト
//
// 全テナントの匿名統計をLLMプロンプトに注入するためのモジュール。
// PII除去ルール:
//   - tenant_id / テナント名 / visitor_id / 具体的なチャット内容 を含めない
//   - faq_embeddings テーブルに一切アクセスしない（テナント固有ナレッジ漏洩防止）
//   - 集計値（平均・件数・比率）のみを返す
// キャッシュ: 1時間TTL のインメモリキャッシュ（DB負荷最小化）
// エラー: 全クエリ失敗時は空コンテキストを返す（silent fail）

import { pool } from './db';
import { logger } from './logger';

// ─── 型定義 ─────────────────────────────────────────────────────────────────

export interface CrossTenantContext {
  avgScores: {
    overall: number;
    psychologyFit: number;
    customerReaction: number;
    stageProgress: number;
  } | null;
  topPsychologyPrinciples: Array<{
    principle: string;
    conversionRate: number;
    sampleSize: number;
  }>;
  commonGapPatterns: string[];
  effectiveRulePatterns: string[];
  totalTenants: number;
  dataAsOf: string;
}

const EMPTY_CTX: CrossTenantContext = {
  avgScores: null,
  topPsychologyPrinciples: [],
  commonGapPatterns: [],
  effectiveRulePatterns: [],
  totalTenants: 0,
  dataAsOf: new Date().toISOString(),
};

// ─── インメモリキャッシュ ─────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000; // 1時間

let _cache: { ctx: CrossTenantContext; expiresAt: number } | null = null;

/** テスト用キャッシュクリア */
export function _clearCacheForTesting(): void {
  _cache = null;
}

// ─── 集計クエリ（テーブル存在チェック付き） ────────────────────────────────

/** PostgreSQL エラーコード 42P01: テーブルが存在しない */
function isTableNotFoundError(err: unknown): boolean {
  return (err as any)?.code === '42P01';
}

async function fetchAvgScores(): Promise<{ avgScores: CrossTenantContext['avgScores']; totalTenants: number }> {
  if (!pool) return { avgScores: null, totalTenants: 0 };
  try {
    const result = await pool.query(`
      SELECT
        ROUND(AVG(score)::numeric, 1)                    AS avg_overall,
        ROUND(AVG(psychology_fit_score)::numeric, 1)     AS avg_psych,
        ROUND(AVG(customer_reaction_score)::numeric, 1)  AS avg_reaction,
        ROUND(AVG(stage_progress_score)::numeric, 1)     AS avg_stage,
        COUNT(DISTINCT tenant_id)                        AS total_tenants
      FROM conversation_evaluations
      WHERE evaluated_at > NOW() - INTERVAL '90 days'
    `);
    const row = result.rows[0];
    if (!row || row.total_tenants === '0' || row.total_tenants === 0) {
      return { avgScores: null, totalTenants: 0 };
    }
    return {
      avgScores: {
        overall: Number(row.avg_overall ?? 0),
        psychologyFit: Number(row.avg_psych ?? 0),
        customerReaction: Number(row.avg_reaction ?? 0),
        stageProgress: Number(row.avg_stage ?? 0),
      },
      totalTenants: Number(row.total_tenants ?? 0),
    };
  } catch (err) {
    if (!isTableNotFoundError(err)) {
      logger.warn({ err }, '[crossTenantContext] fetchAvgScores failed');
    }
    return { avgScores: null, totalTenants: 0 };
  }
}

async function fetchTopPsychologyPrinciples(): Promise<CrossTenantContext['topPsychologyPrinciples']> {
  if (!pool) return [];
  try {
    const result = await pool.query(`
      SELECT
        unnest(psychology_principle_used) AS principle,
        COUNT(*)                          AS total,
        ROUND(
          COUNT(*) FILTER (WHERE conversion_value IS NOT NULL AND conversion_value > 0)::numeric
          / NULLIF(COUNT(*), 0) * 100, 1
        )                                 AS cv_rate
      FROM conversion_attributions
      WHERE created_at > NOW() - INTERVAL '90 days'
      GROUP BY principle
      HAVING COUNT(*) >= 5
      ORDER BY cv_rate DESC
      LIMIT 10
    `);
    return (result.rows as Array<{ principle: string | null; total: string; cv_rate: string | null }>).map((row) => ({
      principle: String(row.principle ?? ''),
      conversionRate: Number(row.cv_rate ?? 0),
      sampleSize: Number(row.total ?? 0),
    }));
  } catch (err) {
    if (!isTableNotFoundError(err)) {
      logger.warn({ err }, '[crossTenantContext] fetchTopPsychologyPrinciples failed');
    }
    return [];
  }
}

async function fetchCommonGapPatterns(): Promise<string[]> {
  if (!pool) return [];
  try {
    const result = await pool.query(`
      SELECT
        COALESCE(detection_source, 'unknown') AS pattern,
        COUNT(*)                              AS gap_count
      FROM knowledge_gaps
      WHERE status = 'open'
        AND created_at > NOW() - INTERVAL '90 days'
      GROUP BY detection_source
      ORDER BY gap_count DESC
      LIMIT 5
    `);
    return (result.rows as Array<{ pattern: string; gap_count: string }>).map((row) => `${row.pattern}(${row.gap_count}件)`);
  } catch (err) {
    if (!isTableNotFoundError(err)) {
      logger.warn({ err }, '[crossTenantContext] fetchCommonGapPatterns failed');
    }
    return [];
  }
}

async function fetchEffectiveRulePatterns(): Promise<string[]> {
  if (!pool) return [];
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)                                 AS total_rules,
        COUNT(*) FILTER (WHERE is_active = true) AS active_rules
      FROM tuning_rules
    `);
    const row = result.rows[0];
    if (!row || Number(row.total_rules) === 0) return [];
    return [`全テナント合計${row.total_rules}件（有効: ${row.active_rules}件）`];
  } catch (err) {
    if (!isTableNotFoundError(err)) {
      logger.warn({ err }, '[crossTenantContext] fetchEffectiveRulePatterns failed');
    }
    return [];
  }
}

// ─── 公開関数 ────────────────────────────────────────────────────────────────

/**
 * 全テナントの匿名集計統計を返す。1時間TTLのインメモリキャッシュ付き。
 * エラー時は空コンテキストを返す（silent fail）。
 * PII・テナント固有ナレッジは含まない。
 */
export async function getCrossTenantContext(): Promise<CrossTenantContext> {
  const now = Date.now();
  if (_cache && _cache.expiresAt > now) {
    return _cache.ctx;
  }

  try {
    const [
      { avgScores, totalTenants },
      topPsychologyPrinciples,
      commonGapPatterns,
      effectiveRulePatterns,
    ] = await Promise.all([
      fetchAvgScores(),
      fetchTopPsychologyPrinciples(),
      fetchCommonGapPatterns(),
      fetchEffectiveRulePatterns(),
    ]);

    const ctx: CrossTenantContext = {
      avgScores,
      topPsychologyPrinciples,
      commonGapPatterns,
      effectiveRulePatterns,
      totalTenants,
      dataAsOf: new Date().toISOString(),
    };

    _cache = { ctx, expiresAt: now + CACHE_TTL_MS };
    return ctx;
  } catch (err) {
    logger.warn({ err }, '[crossTenantContext] getCrossTenantContext failed, returning empty');
    return { ...EMPTY_CTX, dataAsOf: new Date().toISOString() };
  }
}

/**
 * CrossTenantContext を LLMプロンプト注入用の文字列にフォーマットする。
 * データが空の場合は空文字列を返す（セクション省略のため）。
 */
export function formatCrossTenantContext(ctx: CrossTenantContext): string {
  const lines: string[] = [];

  if (ctx.avgScores) {
    lines.push(
      `- 全体平均スコア: 総合${ctx.avgScores.overall}点、心理適合${ctx.avgScores.psychologyFit}点、顧客反応${ctx.avgScores.customerReaction}点、商談進展${ctx.avgScores.stageProgress}点`,
    );
  }

  if (ctx.topPsychologyPrinciples.length > 0) {
    const principlesStr = ctx.topPsychologyPrinciples
      .map((p) => `${p.principle}(CV率+${p.conversionRate}%)`)
      .join(', ');
    lines.push(`- 効果的な心理原則: ${principlesStr}`);
  }

  if (ctx.commonGapPatterns.length > 0) {
    lines.push(`- よくある未回答パターン: ${ctx.commonGapPatterns.join(', ')}`);
  }

  if (ctx.effectiveRulePatterns.length > 0) {
    lines.push(`- 有効ルール数: ${ctx.effectiveRulePatterns.join(', ')}`);
  }

  if (lines.length === 0) return '';

  return `## クロステナント統計（匿名集計）\n${lines.join('\n')}`;
}
