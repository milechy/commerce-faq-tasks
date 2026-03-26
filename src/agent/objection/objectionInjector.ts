// src/agent/objection/objectionInjector.ts
// Phase46: SalesFlowに反論パターンの成功事例を注入する

// @ts-ignore
import { Pool } from 'pg';
import pino from 'pino';
import { OBJECTION_KEYWORDS } from './objectionDetector';

const logger = pino();

export interface InjectionContext {
  patterns: Array<{
    trigger_phrase: string;
    response_strategy: string;
    success_rate: number;
  }>;
}

/**
 * ユーザーメッセージから反論キーワードを検出し、
 * objection_patternsから類似パターンをテキスト検索で取得。
 * success_rate降順で上位3件を返す。
 */
export async function findRelevantObjectionPatterns(
  tenantId: string,
  userMessage: string,
  pool: InstanceType<typeof Pool>,
): Promise<InjectionContext> {
  // 反論キーワードが含まれない場合はDBアクセスせず空を返す（パフォーマンス最適化）
  const hasObjection = OBJECTION_KEYWORDS.some((kw) => userMessage.includes(kw));
  if (!hasObjection) {
    return { patterns: [] };
  }

  try {
    const result = await pool.query<{
      trigger_phrase: string;
      response_strategy: string;
      success_rate: number;
    }>(
      `SELECT trigger_phrase, response_strategy, success_rate
       FROM objection_patterns
       WHERE tenant_id = $1 AND sample_count > 0
       ORDER BY success_rate DESC
       LIMIT 3`,
      [tenantId],
    );

    return { patterns: result.rows };
  } catch (err) {
    logger.warn({ err, tenantId, tag: 'objection-find' }, 'Failed to find objection patterns, returning empty');
    return { patterns: [] };
  }
}

/**
 * 成功パターンをシステムプロンプト注入用文字列に変換。
 * 最大3パターンまで。
 *
 * 出力フォーマット:
 * 【過去の成功パターン（内部参考用 — そのまま使わず自然に応用してください）】
 * この顧客の反論に似た過去の成功事例:
 *
 * 「{trigger_phrase}」と言われた時 → {response_strategy}（成功率: {success_rate*100}%）
 * ...
 */
export function buildObjectionInjectionPrompt(context: InjectionContext): string {
  if (context.patterns.length === 0) return '';

  const topPatterns = context.patterns.slice(0, 3);

  const lines = topPatterns.map((p) => {
    const successPct = Math.round(p.success_rate * 100);
    return `「${p.trigger_phrase}」と言われた時 → ${p.response_strategy}（成功率: ${successPct}%）`;
  });

  return [
    '【過去の成功パターン（内部参考用 — そのまま使わず自然に応用してください）】',
    'この顧客の反論に似た過去の成功事例:',
    '',
    ...lines,
  ].join('\n');
}
