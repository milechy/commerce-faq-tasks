// src/agent/report/weeklyReportGenerator.ts
// Phase46: 週次レポート自動生成（毎週月曜AM9:00）

// @ts-ignore
import { Pool } from 'pg';
import pino from 'pino';
import { callGroqWith429Retry } from '../llm/groqClient';

const logger = pino();

const REPORT_MODEL = 'llama-3.3-70b-versatile';

export interface WeeklyMetrics {
  avgScore: number;
  prevAvgScore: number | null;
  appointmentRate: number;  // outcome='appointment' の割合
  prevAppointmentRate: number | null;
  variantComparison: Array<{ variantId: string; variantName: string | null; avgScore: number }>;
  newObjectionPatterns: number;
  pendingTuningRules: number;
}

/**
 * 直近7日間のメトリクスを収集する。
 */
export async function collectWeeklyMetrics(
  tenantId: string,
  pool: InstanceType<typeof Pool>,
  periodStart: Date,
  periodEnd: Date,
): Promise<WeeklyMetrics> {
  // 当週の平均スコア
  const avgScoreResult = await pool.query(
    `SELECT AVG(score) as avg_score, COUNT(*) as eval_count
     FROM conversation_evaluations
     WHERE tenant_id = $1 AND evaluated_at >= $2 AND evaluated_at < $3`,
    [tenantId, periodStart, periodEnd],
  );
  const avgScore = parseFloat(avgScoreResult.rows[0]?.avg_score ?? '0') || 0;

  // 前週の平均スコア
  const prevPeriodEnd = new Date(periodStart);
  const prevPeriodStart = new Date(periodStart);
  prevPeriodStart.setDate(prevPeriodStart.getDate() - 7);

  const prevAvgScoreResult = await pool.query(
    `SELECT AVG(score) as avg_score
     FROM conversation_evaluations
     WHERE tenant_id = $1 AND evaluated_at >= $2 AND evaluated_at < $3`,
    [tenantId, prevPeriodStart, prevPeriodEnd],
  );
  const prevAvgScoreRaw = prevAvgScoreResult.rows[0]?.avg_score;
  const prevAvgScore = prevAvgScoreRaw !== null && prevAvgScoreRaw !== undefined
    ? parseFloat(prevAvgScoreRaw) || 0
    : null;

  // アポイントメント率
  let appointmentRate = 0;
  let prevAppointmentRate: number | null = null;

  try {
    const kpiResult = await pool.query(
      `SELECT outcome, COUNT(*) as cnt
       FROM sales_kpi_logs
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
       GROUP BY outcome`,
      [tenantId, periodStart, periodEnd],
    );

    let totalCount = 0;
    let appointmentCount = 0;
    for (const row of kpiResult.rows) {
      const cnt = parseInt(row.cnt, 10);
      totalCount += cnt;
      if (row.outcome === 'appointment') {
        appointmentCount = cnt;
      }
    }
    appointmentRate = totalCount > 0 ? appointmentCount / totalCount : 0;

    // 前週のアポイントメント率
    const prevKpiResult = await pool.query(
      `SELECT outcome, COUNT(*) as cnt
       FROM sales_kpi_logs
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
       GROUP BY outcome`,
      [tenantId, prevPeriodStart, prevPeriodEnd],
    );

    let prevTotalCount = 0;
    let prevAppointmentCount = 0;
    for (const row of prevKpiResult.rows) {
      const cnt = parseInt(row.cnt, 10);
      prevTotalCount += cnt;
      if (row.outcome === 'appointment') {
        prevAppointmentCount = cnt;
      }
    }
    prevAppointmentRate = prevTotalCount > 0 ? prevAppointmentCount / prevTotalCount : 0;
  } catch (err) {
    logger.warn({ err, tenantId }, 'weeklyReport.collectMetrics.kpi.skipped');
    appointmentRate = 0;
    prevAppointmentRate = null;
  }

  // バリアント比較
  let variantComparison: Array<{ variantId: string; variantName: string | null; avgScore: number }> = [];
  try {
    const variantResult = await pool.query(
      `SELECT cs.prompt_variant_id, cs.prompt_variant_name, AVG(ce.score) as avg_score
       FROM conversation_evaluations ce
       JOIN chat_sessions cs ON cs.session_id = ce.session_id
       WHERE ce.tenant_id = $1 AND ce.evaluated_at >= $2 AND ce.evaluated_at < $3
       GROUP BY cs.prompt_variant_id, cs.prompt_variant_name`,
      [tenantId, periodStart, periodEnd],
    );
    variantComparison = variantResult.rows.map((row: any) => ({
      variantId: row.prompt_variant_id ?? 'unknown',
      variantName: row.prompt_variant_name ?? null,
      avgScore: parseFloat(row.avg_score) || 0,
    }));
  } catch (err) {
    logger.warn({ err, tenantId }, 'weeklyReport.collectMetrics.variant.skipped');
  }

  // 新規反論パターン数
  let newObjectionPatterns = 0;
  try {
    const objectionResult = await pool.query(
      `SELECT COUNT(*) as cnt
       FROM objection_patterns
       WHERE tenant_id = $1 AND created_at >= $2`,
      [tenantId, periodStart],
    );
    newObjectionPatterns = parseInt(objectionResult.rows[0]?.cnt ?? '0', 10);
  } catch (err) {
    logger.warn({ err, tenantId }, 'weeklyReport.collectMetrics.objection.skipped');
  }

  // 承認待ちチューニングルール数
  let pendingTuningRules = 0;
  try {
    const tuningResult = await pool.query(
      `SELECT COUNT(*) as cnt
       FROM tuning_rules
       WHERE tenant_id = $1 AND approved_at IS NULL AND rejected_at IS NULL`,
      [tenantId],
    );
    pendingTuningRules = parseInt(tuningResult.rows[0]?.cnt ?? '0', 10);
  } catch (err) {
    logger.warn({ err, tenantId }, 'weeklyReport.collectMetrics.tuning.skipped');
  }

  logger.info(
    { tenantId, avgScore, appointmentRate, newObjectionPatterns, pendingTuningRules },
    'weeklyReport.collectMetrics.done',
  );

  return {
    avgScore,
    prevAvgScore,
    appointmentRate,
    prevAppointmentRate,
    variantComparison,
    newObjectionPatterns,
    pendingTuningRules,
  };
}

/**
 * Groq 70bでレポート文を生成する。
 * データなし（avgScore=0, evaluations=0）の場合は
 * 「今週は対象会話がありませんでした」を含む簡易メッセージを返す。
 */
export async function generateReportText(
  metrics: WeeklyMetrics,
  periodStart: Date,
  periodEnd: Date,
): Promise<string> {
  // データなし判定
  if (metrics.avgScore === 0) {
    const startStr = formatDate(periodStart);
    const endStr = formatDate(periodEnd);
    return `【週次改善レポート ${startStr} - ${endStr}】\n今週は対象会話がありませんでした。来週以降のデータ蓄積をお待ちください。`;
  }

  const startStr = formatDate(periodStart);
  const endStr = formatDate(periodEnd);

  const scoreChange = metrics.prevAvgScore !== null
    ? `（前週比 ${metrics.avgScore - metrics.prevAvgScore >= 0 ? '+' : ''}${(metrics.avgScore - metrics.prevAvgScore).toFixed(1)}点）`
    : '';

  const appointmentRateStr = `${(metrics.appointmentRate * 100).toFixed(1)}%`;
  const prevAppointmentRateStr = metrics.prevAppointmentRate !== null
    ? `（前週比 ${((metrics.appointmentRate - metrics.prevAppointmentRate) * 100) >= 0 ? '+' : ''}${((metrics.appointmentRate - metrics.prevAppointmentRate) * 100).toFixed(1)}%pt）`
    : '';

  const variantStr = metrics.variantComparison.length > 0
    ? metrics.variantComparison
        .map(v => `  - ${v.variantName ?? v.variantId}: 平均スコア ${v.avgScore.toFixed(1)}点`)
        .join('\n')
    : '  - データなし';

  const prompt = `あなたはコマースAIのパートナー向けレポートライターです。
以下の週次メトリクスをもとに、パートナー（非技術者）向けに分かりやすい週次改善レポートを日本語で作成してください。

## 対象期間
${startStr} ～ ${endStr}

## 今週のメトリクス
- 会話品質スコア（平均）: ${metrics.avgScore.toFixed(1)}点${scoreChange}
- アポイントメント率: ${appointmentRateStr}${prevAppointmentRateStr}
- 新規反論パターン検出数: ${metrics.newObjectionPatterns}件
- 承認待ちチューニングルール数: ${metrics.pendingTuningRules}件

## バリアント別スコア
${variantStr}

## レポート作成ルール
1. 専門用語を使わず、平易な日本語で書く
2. 数値を具体的に引用する（「スコアが上がりました」ではなく「スコアが○点から○点に向上しました」）
3. 良かった点・改善が必要な点をバランスよく記載する
4. 来週への具体的な改善提案を1〜2つ含める
5. 全体を800文字以内にまとめる
6. 冒頭に【週次改善レポート ${startStr} - ${endStr}】という見出しをつける`;

  try {
    const reportText = await callGroqWith429Retry(
      {
        model: REPORT_MODEL,
        messages: [
          {
            role: 'system',
            content: 'パートナー向け週次改善レポートライターです。平易な日本語で、数値を具体的に引用したレポートを作成します。',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.4,
        maxTokens: 1024,
        tag: 'weekly-report',
      },
      { logger },
    );

    // 1000文字以内に収める
    return reportText.length > 1000 ? reportText.slice(0, 997) + '...' : reportText;
  } catch (err) {
    logger.error({ err }, 'weeklyReport.generateReportText.failed');
    return `【週次改善レポート ${startStr} - ${endStr}】\nレポート生成中にエラーが発生しました。管理者にお問い合わせください。`;
  }
}

/**
 * レポートをweekly_reportsテーブルに保存する。
 */
export async function saveWeeklyReport(params: {
  tenantId: string;
  reportText: string;
  periodStart: Date;
  periodEnd: Date;
  metrics: WeeklyMetrics;
  slackPosted: boolean;
  pool: InstanceType<typeof Pool>;
}): Promise<void> {
  const { tenantId, reportText, periodStart, periodEnd, metrics, slackPosted, pool } = params;

  await pool.query(
    `INSERT INTO weekly_reports
       (tenant_id, report_text, period_start, period_end, metrics, slack_posted)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      tenantId,
      reportText,
      periodStart,
      periodEnd,
      JSON.stringify(metrics),
      slackPosted,
    ],
  );

  logger.info({ tenantId, periodStart, periodEnd, slackPosted }, 'weeklyReport.saved');
}

/**
 * Slack #rajiuce-dev にレポートを投稿する。
 * SLACK_WEBHOOK_URL が未設定の場合はスキップ。
 * 投稿フォーマット:
 * 📊 RAJIUCE 週次改善レポート（{MM/DD} - {MM/DD}）
 * {report_text}
 * 詳細は Admin UI > AI改善レポートで確認できます。
 */
export async function postReportToSlack(
  reportText: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<boolean> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    logger.info('weeklyReport.slack.skipped: SLACK_WEBHOOK_URL not set');
    return false;
  }

  const startStr = formatDateShort(periodStart);
  const endStr = formatDateShort(periodEnd);

  const text = [
    `📊 RAJIUCE 週次改善レポート（${startStr} - ${endStr}）`,
    reportText,
    '詳細は Admin UI > AI改善レポートで確認できます。',
  ].join('\n');

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      logger.error(
        { status: response.status, statusText: response.statusText },
        'weeklyReport.slack.postFailed',
      );
      return false;
    }

    logger.info({ periodStart, periodEnd }, 'weeklyReport.slack.posted');
    return true;
  } catch (err) {
    logger.error({ err }, 'weeklyReport.slack.error');
    return false;
  }
}


// ユーティリティ

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}/${m}/${d}`;
}

function formatDateShort(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${m}/${d}`;
}
