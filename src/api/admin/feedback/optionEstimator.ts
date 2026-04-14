// src/api/admin/feedback/optionEstimator.ts
// Phase62: オプションサービス料金試算（Groq 70B呼び出し）

import { logger } from '../../../lib/logger';

const GROQ_API_BASE = 'https://api.groq.com/openai/v1/chat/completions';

export interface EstimateResult {
  estimated_amount: number;  // 円
  breakdown: string;         // 内訳説明
  estimated_hours: number;   // 想定作業時間
}

const ESTIMATE_SYSTEM_PROMPT = `あなたはIT業務の料金見積もり専門家です。
以下の作業内容について、東京都のITベンダーに発注した場合の相場を試算してください。

## 試算ルール
- 基準: 東京都のフリーランスエンジニアまたは小規模ITベンダーの時給相場（¥5,000〜¥15,000/時間）
- 作業の複雑さ、必要な専門知識、想定所要時間を考慮
- 最低料金: ¥3,000（30分未満の軽微な作業でも）
- 最高料金: ¥100,000（1日を超える大規模作業の場合は別途見積もりを推奨）

## 出力形式（JSONのみ、他のテキストは不要）
{"estimated_amount": 数値, "breakdown": "内訳の説明", "estimated_hours": 数値}

例:
{"estimated_amount": 8000, "breakdown": "アバター画像生成・声設定・プロンプト調整（約1.5時間、時給¥5,500相当）", "estimated_hours": 1.5}`;

/** 作業内容の説明から料金を試算する */
export async function estimateOptionPrice(
  taskDescription: string,
  tenantContext?: string,
): Promise<EstimateResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    logger.warn('[estimateOptionPrice] GROQ_API_KEY not set, using fallback');
    return fallback();
  }

  const userPrompt =
    `## 作業内容\n${taskDescription}` +
    (tenantContext ? `\n\n## テナント環境情報\n${tenantContext}` : '');

  try {
    const response = await fetch(GROQ_API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL_70B ?? 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: ESTIMATE_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 300,
      }),
    });

    if (!response.ok) {
      logger.warn('[estimateOptionPrice] Groq API error:', response.status);
      return fallback();
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim() ?? '';
    const jsonMatch = content.match(/\{[\s\S]*"estimated_amount"[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('[estimateOptionPrice] No JSON in response');
      return fallback();
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      estimated_amount?: number;
      breakdown?: string;
      estimated_hours?: number;
    };

    return {
      estimated_amount: Math.round(Number(parsed.estimated_amount) || 10000),
      breakdown: parsed.breakdown || '内訳不明',
      estimated_hours: Number(parsed.estimated_hours) || 1,
    };
  } catch (err) {
    logger.warn('[estimateOptionPrice] failed, using fallback', err);
    return fallback();
  }
}

function fallback(): EstimateResult {
  return {
    estimated_amount: 10000,
    breakdown: '自動見積もりに失敗したため、標準料金を適用',
    estimated_hours: 2,
  };
}
