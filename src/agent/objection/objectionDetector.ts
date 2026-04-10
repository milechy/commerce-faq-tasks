// src/agent/objection/objectionDetector.ts
// Phase46: 会話履歴から反論→対応→肯定パターンを自動検出し、objection_patternsに蓄積

// @ts-ignore
import { Pool } from 'pg';
import pino from 'pino';
import { callGroqWith429Retry } from '../llm/groqClient';

const logger = pino();

// 反論キーワードリスト
export const OBJECTION_KEYWORDS = ['高い', '高すぎ', '他社', '安い', '必要ない', '考えます', '検討', '予算', '値段', '費用'];

// 肯定反応キーワードリスト
const POSITIVE_KEYWORDS =['なるほど', 'それなら', 'そうですね', 'わかりました', '確かに', 'ありがとう', '検討します', '興味'];

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface DetectedPattern {
  triggerPhrase: string;    // 顧客の反論（ターンN）
  responseStrategy: string; // AIの対応要約（ターンN+1）
  principleUsed: string | null; // 使用した原則（metadata.used_principlesから）
}

/**
 * 会話メッセージ配列から反論→対応→肯定の3ターンパターンを検出する。
 * - ターンN: userのメッセージにOBJECTION_KEYWORDS含む
 * - ターンN+1: assistantの応答
 * - ターンN+2: userのメッセージにPOSITIVE_KEYWORDS含む
 */
export function detectObjectionPatterns(messages: ChatMessage[]): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];

  for (let i = 0; i < messages.length - 2; i++) {
    const turnN = messages[i];
    const turnN1 = messages[i + 1];
    const turnN2 = messages[i + 2];

    // ターンN: userの反論
    if (turnN.role !== 'user') continue;
    const hasObjection = OBJECTION_KEYWORDS.some((kw) => turnN.content.includes(kw));
    if (!hasObjection) continue;

    // ターンN+1: assistantの応答
    if (turnN1.role !== 'assistant') continue;

    // ターンN+2: userの肯定反応
    if (turnN2.role !== 'user') continue;
    const hasPositive = POSITIVE_KEYWORDS.some((kw) => turnN2.content.includes(kw));
    if (!hasPositive) continue;

    // principleUsedをメタデータから取得
    let principleUsed: string | null = null;
    if (turnN1.metadata?.used_principles) {
      const principles = turnN1.metadata.used_principles;
      if (Array.isArray(principles) && principles.length > 0) {
        principleUsed = (principles as string[]).join(', ');
      } else if (typeof principles === 'string') {
        principleUsed = principles;
      }
    }

    patterns.push({
      triggerPhrase: turnN.content,
      responseStrategy: turnN1.content,
      principleUsed,
    });
  }

  return patterns;
}

/**
 * 検出したパターンをGroq 8bで構造化し、objection_patternsテーブルにUPSERT。
 * source='auto'。
 * 既存レコードが存在する場合はsuccess_rate と sample_countを更新。
 */
export async function saveObjectionPatterns(
  tenantId: string,
  patterns: DetectedPattern[],
  pool: InstanceType<typeof Pool>,
): Promise<void> {
  if (patterns.length === 0) return;

  for (const pattern of patterns) {
    let triggerPhrase = pattern.triggerPhrase;
    let responseStrategy = pattern.responseStrategy;

    // Groq 8bでtriggerPhraseを正規化、responseStrategyを1文で要約
    try {
      const normalized = await callGroqWith429Retry(
        {
          model: 'llama3-8b-8192',
          messages: [
            {
              role: 'system',
              content:
                'あなたはセールス会話の反論パターンを分析するアシスタントです。JSONのみで回答してください。',
            },
            {
              role: 'user',
              content: `以下の反論と対応を短く正規化してください。
反論: ${triggerPhrase.slice(0, 200)}
対応: ${responseStrategy.slice(0, 200)}

JSONフォーマットで返してください:
{"trigger_phrase": "正規化された反論（20文字以内）", "response_strategy": "対応の1文要約（50文字以内）"}`,
            },
          ],
          temperature: 0,
          maxTokens: 256,
          tag: 'objection-normalize',
        },
      );

      const parsed = JSON.parse(normalized.trim());
      if (parsed.trigger_phrase && typeof parsed.trigger_phrase === 'string') {
        triggerPhrase = parsed.trigger_phrase.slice(0, 200);
      }
      if (parsed.response_strategy && typeof parsed.response_strategy === 'string') {
        responseStrategy = parsed.response_strategy.slice(0, 200);
      }
    } catch (err) {
      logger.warn({ err, tag: 'objection-normalize' }, 'Groq normalization failed, using original values');
      // フォールバック: そのままのtriggerPhrase/responseStrategyを使う
      triggerPhrase = triggerPhrase.slice(0, 200);
      responseStrategy = responseStrategy.slice(0, 200);
    }

    // UPSERTクエリ
    try {
      await pool.query(
        `INSERT INTO objection_patterns
          (tenant_id, trigger_phrase, response_strategy, principle_used, success_rate, sample_count, source, updated_at)
         VALUES ($1, $2, $3, $4, 1.0, 1, 'auto', NOW())
         ON CONFLICT (tenant_id, trigger_phrase) DO UPDATE SET
           response_strategy = EXCLUDED.response_strategy,
           sample_count = objection_patterns.sample_count + 1,
           success_rate = (objection_patterns.success_rate * objection_patterns.sample_count + 1.0) / (objection_patterns.sample_count + 1),
           updated_at = NOW()`,
        [tenantId, triggerPhrase, responseStrategy, pattern.principleUsed],
      );
    } catch (err) {
      logger.warn({ err, tenantId, tag: 'objection-upsert' }, 'Failed to upsert objection pattern');
    }
  }
}
