// src/api/conversion/autoTuning.ts
// Phase58: Auto-tuning フライホイール
// Judge提案集約 + A/Bテスト勝者検出 + 心理原則効果ランキング → In-App通知

import { pool } from '../../lib/db';
import { createNotification, notificationExists } from '../../lib/notifications';

export interface AutoTuningCandidate {
  type: 'judge_repeated' | 'ab_winner' | 'effectiveness_top';
  description: string;
  suggestedAction: string;
  data: Record<string, unknown>;
}

/**
 * Judge提案の重複検出（30日以内に3回以上同じルール提案）
 */
export async function detectRepeatedJudgeSuggestions(
  tenantId: string,
): Promise<AutoTuningCandidate[]> {
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT unnest(suggested_rules) AS rule, COUNT(*) AS cnt
       FROM conversation_evaluations
       WHERE tenant_id = $1
         AND created_at >= NOW() - INTERVAL '30 days'
         AND suggested_rules IS NOT NULL
       GROUP BY rule
       HAVING COUNT(*) >= 3
       ORDER BY cnt DESC
       LIMIT 5`,
      [tenantId],
    );

    return (result.rows as Array<{ rule: string; cnt: string }>).map((r) => ({
      type: 'judge_repeated' as const,
      description: `AIが${r.cnt}回同じ提案をしています`,
      suggestedAction: r.rule,
      data: { count: Number(r.cnt), rule: r.rule },
    }));
  } catch {
    return [];
  }
}

/**
 * A/Bテスト勝者検出（running + min_sample_size達成 + 5%以上の差）
 */
export async function detectABWinners(
  tenantId: string,
): Promise<AutoTuningCandidate[]> {
  if (!pool) return [];
  try {
    type AbRow = { id: string; name: string; count_a: string; conv_a: string; count_b: string; conv_b: string };
    const experiments = await pool.query(
      `SELECT e.id, e.name, e.variant_a, e.variant_b, e.min_sample_size,
         COUNT(r.id) FILTER (WHERE r.variant = 'a') AS count_a,
         COUNT(r.id) FILTER (WHERE r.variant = 'a' AND r.converted) AS conv_a,
         COUNT(r.id) FILTER (WHERE r.variant = 'b') AS count_b,
         COUNT(r.id) FILTER (WHERE r.variant = 'b' AND r.converted) AS conv_b
       FROM ab_experiments e
       LEFT JOIN ab_results r ON e.id = r.experiment_id
       WHERE e.tenant_id = $1 AND e.status = 'running'
       GROUP BY e.id
       HAVING COUNT(r.id) >= e.min_sample_size`,
      [tenantId],
    );

    return (experiments.rows as AbRow[])
      .filter((e) => {
        const rateA = Number(e.count_a) > 0 ? Number(e.conv_a) / Number(e.count_a) : 0;
        const rateB = Number(e.count_b) > 0 ? Number(e.conv_b) / Number(e.count_b) : 0;
        return Math.abs(rateA - rateB) > 0.05;
      })
      .map((e) => {
        const rateA = Number(e.count_a) > 0 ? Number(e.conv_a) / Number(e.count_a) : 0;
        const rateB = Number(e.count_b) > 0 ? Number(e.conv_b) / Number(e.count_b) : 0;
        const winner = rateA >= rateB ? 'A' : 'B';
        return {
          type: 'ab_winner' as const,
          description: `A/Bテスト「${e.name}」でVariant ${winner}が勝利`,
          suggestedAction: `Variant ${winner}を適用`,
          data: { experimentId: e.id, rateA, rateB, winner },
        };
      });
  } catch {
    return [];
  }
}

/**
 * 効果ランキング上位の心理原則（30日で5件以上CV）
 */
export async function detectTopPrinciples(
  tenantId: string,
): Promise<AutoTuningCandidate[]> {
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT unnest(psychology_principle_used) AS principle,
              COUNT(*) AS total,
              AVG(temp_score_at_conversion) AS avg_temp
       FROM conversion_attributions
       WHERE tenant_id = $1
         AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY principle
       HAVING COUNT(*) >= 5
       ORDER BY total DESC
       LIMIT 3`,
      [tenantId],
    );

    return (result.rows as Array<{ principle: string; total: string; avg_temp: string | null }>).map((r) => ({
      type: 'effectiveness_top' as const,
      description: `「${r.principle}」が${r.total}回のCVに貢献（平均温度感${Math.round(Number(r.avg_temp ?? 0))}）`,
      suggestedAction: `「${r.principle}」をチューニングルールで優先設定`,
      data: { principle: r.principle, count: Number(r.total), avgTemp: Number(r.avg_temp ?? 0) },
    }));
  } catch {
    return [];
  }
}

/**
 * 全候補を集約して重複しないIn-App通知を送信する。
 * fire-and-forget で呼ぶことを想定。
 */
async function runAutoTuningCheck(tenantId: string): Promise<void> {
  if (!pool) return;

  const [judgeResults, abResults, principleResults] = await Promise.all([
    detectRepeatedJudgeSuggestions(tenantId),
    detectABWinners(tenantId),
    detectTopPrinciples(tenantId),
  ]);

  const candidates = [...judgeResults, ...abResults, ...principleResults];

  for (const candidate of candidates) {
    // 重複通知防止: type + description の組み合わせ
    const alreadyExists = await notificationExists(
      'auto_tuning_suggestion',
      'description',
      candidate.description,
    );
    if (alreadyExists) continue;

    await createNotification({
      recipientRole: 'client_admin',
      recipientTenantId: tenantId,
      type: 'auto_tuning_suggestion',
      title: '改善提案があります',
      message: candidate.description,
      link: '/admin/conversion',
      metadata: {
        candidate_type: candidate.type,
        description: candidate.description,
        suggested_action: candidate.suggestedAction,
        ...candidate.data,
      },
    });
  }
}
