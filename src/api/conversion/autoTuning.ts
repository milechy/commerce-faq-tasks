// src/api/conversion/autoTuning.ts
// Phase58: Auto-tuning フライホイール
// Judge提案集約 + A/Bテスト勝者検出 + 心理原則効果ランキング → In-App通知

import { pool } from '../../lib/db';
import { createNotification, notificationExists } from '../../lib/notifications';
import { userSourceExistsForTable } from '../admin/analytics/summaryQueries';
import { logger } from '../../lib/logger';

export interface AutoTuningCandidate {
  type: 'judge_repeated' | 'ab_winner' | 'effectiveness_top';
  description: string;
  suggestedAction: string;
  data: Record<string, unknown>;
  /**
   * 重複通知防止に使う安定識別子。description は件数や集計値を埋め込んだ
   * 人が読む文面なので同一性判定には使えない(値が動くたびに別物と判定されて
   * しまう)。rule / experimentId / principle など、提案の元になった対象そのもの
   * を指すキーをここに入れる。
   */
  dedupKey: string;
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
      // suggested_rules は JSONB(migration_evaluations.sql)。unnest() は配列型専用で
       // JSONB を受け取れず必ず例外になる(evaluationsRepository と同じ不具合)。
       // ここは catch で [] を返すため無症状だが、この関数を配線した瞬間に
       // 「常に候補0件」として静かに壊れるため、同時に是正しておく。
      `SELECT rule, COUNT(*) AS cnt
       FROM conversation_evaluations, jsonb_array_elements_text(suggested_rules) AS rule
       WHERE tenant_id = $1
         AND created_at >= NOW() - INTERVAL '30 days'
         AND suggested_rules IS NOT NULL
         ${userSourceExistsForTable("conversation_evaluations", "conversation_evaluations")}
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
      dedupKey: `judge_repeated:${r.rule}`,
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
          dedupKey: `ab_winner:${e.id}`,
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
         ${userSourceExistsForTable("conversion_attributions", "conversion_attributions")}
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
      dedupKey: `effectiveness_top:${r.principle}`,
    }));
  } catch {
    return [];
  }
}

/**
 * 全候補を集約して重複しないIn-App通知を送信する。
 * fire-and-forget で呼ぶことを想定。
 */
export async function runAutoTuningCheck(tenantId: string): Promise<void> {
  if (!pool) return;

  const [judgeResults, abResults, principleResults] = await Promise.all([
    detectRepeatedJudgeSuggestions(tenantId),
    detectABWinners(tenantId),
    detectTopPrinciples(tenantId),
  ]);

  const candidates = [...judgeResults, ...abResults, ...principleResults];

  for (const candidate of candidates) {
    // 重複通知防止: type + dedupKey(rule/experimentId/principle などの安定識別子)
    // の組み合わせ。description は件数・スコアを埋め込んだ人が読む文面のため、
    // それをキーにすると値が動くたびに別物と判定されて再通知されてしまう。
    const alreadyExists = await notificationExists(
      'auto_tuning_suggestion',
      'dedup_key',
      candidate.dedupKey,
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
        dedup_key: candidate.dedupKey,
        description: candidate.description,
        suggested_action: candidate.suggestedAction,
        ...candidate.data,
      },
    });
  }
}

/**
 * 稼働中の全テナットを巡回して runAutoTuningCheck を呼ぶ。
 * billingSyncReconciliation.ts の listTenantsToSync と同じ「起動プロセスへの
 * 定期実行配線」パターン: 1テナントの失敗が他テナントの処理を止めないよう、
 * テナント単位で隔離する。
 */
async function listActiveTenantIds(): Promise<string[]> {
  if (!pool) return [];
  const result = await pool.query(`SELECT id FROM tenants WHERE is_active = true`);
  return (result.rows as Array<{ id: string }>).map((r) => r.id);
}

export async function runAutoTuningSweep(): Promise<void> {
  if (!pool) return;

  let tenantIds: string[];
  try {
    tenantIds = await listActiveTenantIds();
  } catch (err) {
    logger.error({ err }, '[autoTuning] failed to list active tenants');
    return;
  }

  for (const tenantId of tenantIds) {
    try {
      await runAutoTuningCheck(tenantId);
    } catch (err) {
      logger.warn({ err, tenantId }, '[autoTuning] runAutoTuningCheck failed for tenant (non-blocking)');
    }
  }
}

// ---------------------------------------------------------------------------
// 定期実行ラッパー。billingSyncReconciliationMonitor(billingSyncReconciliation.ts)
// と同じ形(二重起動防止・起動直後の初回tick・stop())を踏襲する。
// ---------------------------------------------------------------------------

const AUTO_TUNING_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1時間ごと(billingHealthMonitorと同じ周期)

class AutoTuningMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  start(intervalMs: number = AUTO_TUNING_SWEEP_INTERVAL_MS): void {
    if (this.timer) return; // 二重起動防止(CLAUDE.md 禁止30)
    const tick = () => {
      if (this.isRunning) {
        logger.warn('[autoTuning] previous sweep still running, skipping this tick');
        return;
      }
      this.isRunning = true;
      runAutoTuningSweep()
        .catch((err) => logger.error({ err }, '[autoTuning] scheduled sweep failed'))
        .finally(() => {
          this.isRunning = false;
        });
    };
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
    // 起動直後に1回実行する(次の周期を待たない)。
    tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const autoTuningMonitor = new AutoTuningMonitor();
