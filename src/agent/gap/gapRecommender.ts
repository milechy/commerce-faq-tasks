// src/agent/gap/gapRecommender.ts
// Phase46 Stream B: Gemini 2.5 Flash による Gap 提案エンジン

import pino from 'pino';
import { callGeminiJudge } from '../../lib/gemini/client';
import { getPool } from '../../lib/db';
import {
  searchKnowledgeForSuggestion,
  formatKnowledgeContext,
} from '../../lib/knowledgeSearchUtil';

const logger = pino();
const BATCH_SIZE = 20;

export interface GapRecommendation {
  gapId: number;
  recommendedAction: string;
  suggestedAnswer: string;
}

/**
 * pending状態でrecommended_actionがNULLのギャップに対してGemini提案を生成し、DBに保存する。
 * 1回の呼び出しで最大BATCH_SIZE件をバッチ処理（コスト最小化）。
 * Anti-Slop: user_question / faq answer を Gemini に渡す前に slice(0, 200) 適用。
 * Never throws — errors are logged and empty array is returned on failure.
 */
export async function generateRecommendations(
  tenantId: string,
  limit?: number,
): Promise<GapRecommendation[]> {
  const pool = getPool();
  const batchSize = Math.min(limit ?? BATCH_SIZE, BATCH_SIZE);

  let gapsResult: { rows: Array<{ id: number; user_question: string }> };
  try {
    gapsResult = await pool.query<{ id: number; user_question: string }>(
      `SELECT id, user_question FROM knowledge_gaps
       WHERE tenant_id = $1
         AND status = 'open'
         AND (recommended_action IS NULL OR recommended_action = '')
       ORDER BY COALESCE(frequency, 1) DESC, COALESCE(last_detected_at, created_at) DESC
       LIMIT $2`,
      [tenantId, batchSize],
    );
  } catch (err) {
    logger.warn({ err, tenantId }, 'gapRecommender: DB fetch failed');
    return [];
  }

  if (gapsResult.rows.length === 0) return [];

  // 代表質問（先頭ギャップ）でpgvectorナレッジ検索（faq_docs ILIKEからpgvector意味検索に切り替え）
  const representativeQuery = gapsResult.rows[0]!.user_question;
  const knowledgeCtx = await searchKnowledgeForSuggestion(tenantId, representativeQuery).catch(
    () => ({ results: [] }),
  );
  const faqSummary = formatKnowledgeContext(knowledgeCtx) || '（既存ナレッジなし）';

  // Anti-Slop: user_question を 200 字以内に切り詰めてからプロンプトに埋め込む
  const gapList = gapsResult.rows
    .map((g, i) => `${i + 1}. ${g.user_question.slice(0, 200)}`)
    .join('\n');

  const prompt = `あなたはBtoB営業チャットAIのナレッジ管理アシスタントです。
以下は顧客から聞かれたがAIが適切に答えられなかった質問のリストです。

## 未回答の質問一覧
${gapList}

## 既存ナレッジ概要（参考）
${faqSummary}

各質問に対して以下を提案してください:
1. recommended_action: どんなナレッジを追加すべきか（日本語で簡潔に）
2. suggested_answer: この質問に対するドラフト回答（テナントが編集して使う前提）

以下のJSON配列のみで出力してください（前後の説明文不要）:
[{"index":1,"recommended_action":"...","suggested_answer":"..."},...]`;

  let raw: string;
  try {
    raw = await callGeminiJudge(prompt);
  } catch (err) {
    logger.warn({ err, tenantId }, 'gapRecommender: Gemini call failed');
    return [];
  }

  let parsed: Array<{ index: number; recommended_action: string; suggested_answer: string }>;
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('no JSON array in Gemini response');
    parsed = JSON.parse(jsonMatch[0]) as typeof parsed;
  } catch (err) {
    logger.warn({ err, tenantId }, 'gapRecommender: JSON parse failed');
    return [];
  }

  const recommendations: GapRecommendation[] = [];
  for (const item of parsed) {
    const idx = (item.index ?? 0) - 1;
    const gap = gapsResult.rows[idx];
    if (!gap) continue;

    const recommendedAction = String(item.recommended_action ?? '').slice(0, 500);
    const suggestedAnswer = String(item.suggested_answer ?? '').slice(0, 1000);

    try {
      await pool.query(
        `UPDATE knowledge_gaps
         SET recommended_action = $1,
             suggested_answer   = $2,
             recommendation_status = 'pending'
         WHERE id = $3 AND tenant_id = $4`,
        [recommendedAction, suggestedAnswer, gap.id, tenantId],
      );
      recommendations.push({ gapId: gap.id, recommendedAction, suggestedAnswer });
    } catch (dbErr) {
      logger.warn({ err: dbErr, gapId: gap.id }, 'gapRecommender: DB update failed');
    }
  }

  return recommendations;
}
