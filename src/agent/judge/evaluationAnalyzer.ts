// src/agent/judge/evaluationAnalyzer.ts
// Phase45: 評価結果を分析してチューニングルールを提案する

import { Pool } from 'pg';
import pino from 'pino';
import { callGroqWith429Retry } from '../llm/groqClient';
import { createEvaluationRepository } from './evaluationRepository';

const logger = pino();

const ANALYZER_MODEL = 'llama3-8b-8192';

export interface SuggestedRule {
  triggerPattern: string;
  expectedBehavior: string;
  evidence: {
    evaluationIds: number[];
    effectivePrinciples: string[];
    failedPrinciples: string[];
    avgScore: number;
  };
}

interface PrincipleCount {
  effective: number;
  failed: number;
}

export async function analyzeTuningRules(
  tenantId: string,
  evaluationRepo: ReturnType<typeof createEvaluationRepository>,
  pool: InstanceType<typeof Pool>,
): Promise<SuggestedRule[]> {
  // 1. 直近50件の評価を取得
  const evaluations = await evaluationRepo.getEvaluationsByTenant(tenantId, 50, 0);

  if (evaluations.length === 0) {
    logger.info({ tenantId }, 'evaluationAnalyzer.no_evaluations');
    return [];
  }

  // 2. effective/failed 原則を集計
  const principleStats: Record<string, PrincipleCount> = {};
  const evaluationIds: number[] = [];

  for (const ev of evaluations) {
    if (ev.id != null) evaluationIds.push(ev.id);

    for (const p of ev.effectivePrinciples) {
      if (!principleStats[p]) principleStats[p] = { effective: 0, failed: 0 };
      principleStats[p]!.effective++;
    }
    for (const p of ev.failedPrinciples) {
      if (!principleStats[p]) principleStats[p] = { effective: 0, failed: 0 };
      principleStats[p]!.failed++;
    }
  }

  const avgScore =
    evaluations.reduce((sum, ev) => sum + ev.score, 0) / evaluations.length;

  const effectivePrinciples = Object.entries(principleStats)
    .filter(([, v]) => v.effective > v.failed)
    .map(([k]) => k);

  const failedPrinciples = Object.entries(principleStats)
    .filter(([, v]) => v.failed >= v.effective)
    .map(([k]) => k);

  // 3. Groq 8b でルール提案を生成（最大3つ）
  const prompt = `あなたはコマースAIのチューニングルール提案エキスパートです。

## 評価サマリ
- 評価件数: ${evaluations.length}
- 平均スコア: ${Math.round(avgScore)}
- 効果的だった心理原則: ${effectivePrinciples.join(', ') || 'なし'}
- 効果がなかった/失敗した心理原則: ${failedPrinciples.join(', ') || 'なし'}

## タスク
上記の評価データに基づいて、会話品質を向上させるチューニングルールを最大3つ提案してください。

以下のJSON配列形式のみで回答してください（最大3件）:
[
  {
    "triggerPattern": "トリガーとなるパターンや状況（例：「顧客が価格について質問したとき」）",
    "expectedBehavior": "望ましい応答行動（例：「社会的証明を使って他の顧客の選択を示す」）"
  }
]`;

  let suggestedRules: Array<{ triggerPattern: string; expectedBehavior: string }> = [];

  try {
    const raw = await callGroqWith429Retry(
      {
        model: ANALYZER_MODEL,
        messages: [
          {
            role: 'system',
            content: 'チューニングルール提案エキスパートです。JSON形式のみで回答します。',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        maxTokens: 512,
        tag: 'analyzer',
      },
      { logger },
    );

    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        triggerPattern: string;
        expectedBehavior: string;
      }>;
      suggestedRules = parsed.slice(0, 3);
    }
  } catch (err) {
    logger.error({ err, tenantId }, 'evaluationAnalyzer.groq.failed');
    return [];
  }

  if (suggestedRules.length === 0) return [];

  // 4. tuning_rules テーブルに INSERT
  const result: SuggestedRule[] = [];

  for (const rule of suggestedRules) {
    if (!rule.triggerPattern || !rule.expectedBehavior) continue;

    try {
      // ON CONFLICT DO NOTHING で重複防止（trigger_pattern と tenant_id でユニーク判定）
      await pool.query(
        `INSERT INTO tuning_rules
           (tenant_id, trigger_pattern, expected_behavior, priority,
            source, suggested_at)
         VALUES ($1, $2, $3, $4, 'judge', NOW())
         ON CONFLICT DO NOTHING`,
        [tenantId, rule.triggerPattern, rule.expectedBehavior, 0],
      );

      result.push({
        triggerPattern: rule.triggerPattern,
        expectedBehavior: rule.expectedBehavior,
        evidence: {
          evaluationIds,
          effectivePrinciples,
          failedPrinciples,
          avgScore: Math.round(avgScore),
        },
      });
    } catch (err) {
      logger.error({ err, tenantId, rule }, 'evaluationAnalyzer.insert.failed');
    }
  }

  return result;
}
