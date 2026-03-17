// src/agent/tools/synthesisTool.ts

import type { RerankItem } from '../types';
import { groqClient } from '../llm/groqClient';
import {
  getActiveRulesForTenant,
  buildTuningPromptSection,
} from '../../api/admin/tuning/tuningRulesRepository';

export interface SynthesisInput {
  query: string;
  items: RerankItem[];
  maxChars?: number;
  tenantId?: string;
}

export interface SynthesisOutput {
  answer: string;
}

const DEFAULT_MAX_CHARS = 420;

const BASE_SYSTEM_PROMPT = `あなたは中古車販売店のAIコンシェルジュです。
お客様の質問に対して、提供されたFAQ情報をもとに
親切で自然な日本語で回答してください。
ルール:
- 回答は200文字以内で簡潔に
- FAQにない情報は推測で答えない
- 敬語を使う
- 箇条書きではなく自然な文章で答える
- FAQ情報が不十分な場合は「詳しくはお問い合わせください」と案内する`;

/**
 * チューニングルールのトリガーパターンがクエリにマッチするか判定する。
 * trigger_pattern はカンマ区切りのキーワードリスト。
 */
function matchesTriggerPattern(query: string, triggerPattern: string): boolean {
  const lowerQuery = query.toLowerCase();
  return triggerPattern
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .some((k) => lowerQuery.includes(k.toLowerCase()));
}

/**
 * Groq LLM（llama-3.3-70b-versatile）で自然な日本語回答を生成する。
 * tenantId が指定された場合、アクティブなチューニングルールをシステムプロンプトに注入する。
 * APIキー未設定・エラー時は箇条書きフォールバックを返す。
 */
export async function synthesizeAnswer(input: SynthesisInput): Promise<SynthesisOutput> {
  const { query, items, maxChars = DEFAULT_MAX_CHARS, tenantId } = input;

  // チューニングルールを取得（tenantId がある場合のみ）
  const tuningRules = tenantId
    ? await getActiveRulesForTenant(tenantId).catch(() => [])
    : [];

  // クエリにマッチするルールを絞り込む
  const matchedRules = tuningRules.filter((r) =>
    matchesTriggerPattern(query, r.trigger_pattern),
  );

  // FAQ ヒットなし & マッチするチューニングルールもなし → デフォルトメッセージ
  if (!items.length && matchedRules.length === 0) {
    const msg =
      'ご質問の内容に完全に一致するFAQは見つかりませんでした。' +
      'キーワード（商品名・機能名・「返品」「送料」など）を含めて、もう一度お試しください。';
    return { answer: truncate(msg, maxChars) };
  }

  // Groq APIキーがなければ即フォールバック（FAQ ヒットありの場合のみ）
  if (!process.env.GROQ_API_KEY) {
    if (!items.length) {
      // FAQ なし + チューニングルールあり だが LLM なし → ルール本文を直接返す
      return { answer: truncate(matchedRules[0]!.expected_behavior, maxChars) };
    }
    return fallbackSynthesize(input);
  }

  try {
    // チューニングルールをシステムプロンプトに注入
    const tuningSection = buildTuningPromptSection(matchedRules);
    const systemPrompt = tuningSection
      ? `${BASE_SYSTEM_PROMPT}\n\n${tuningSection}`
      : BASE_SYSTEM_PROMPT;

    // FAQ コンテキスト（ヒットがある場合）
    const faqContext = items.length
      ? items
          .slice(0, 3)
          .map((it, i) => `FAQ${i + 1}:\nQ: ${sanitizeText(it.text)}\nA: ${sanitizeText(it.text)}`)
          .join('\n\n')
      : '';

    const userPrompt = faqContext
      ? `お客様の質問: ${query}\n参考FAQ:\n${faqContext}\n上記のFAQ情報をもとに、お客様の質問に自然な日本語で回答してください。`
      : `お客様の質問: ${query}\n上記の応答ルールに従って、お客様の質問に自然な日本語で回答してください。`;

    const raw = await groqClient.call({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.5,
      maxTokens: 300,
      tag: 'synthesis',
    });

    return { answer: truncate(raw.trim(), maxChars) };
  } catch {
    // フォールバック: 箇条書き
    if (!items.length) {
      return { answer: truncate(matchedRules[0]!.expected_behavior, maxChars) };
    }
    return fallbackSynthesize(input);
  }
}

function fallbackSynthesize(input: SynthesisInput): SynthesisOutput {
  const { query, items, maxChars = DEFAULT_MAX_CHARS } = input;

  // 箇条書きは 2 件までに制限して、よりタイトな回答にする
  const top = items.slice(0, 2);
  const bullets = top
    .map((it) => `・${sanitizeText(it.text)}`)
    .join('\n');

  let answer =
    `ご質問「${query}」に対して、関連性の高いFAQから要点をまとめました。\n` +
    `${bullets}\n\n` +
    '具体的な手順や最新の条件は、各FAQ本文をご確認ください。';

  answer = truncate(answer, maxChars);

  return { answer };
}

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars - 1) + '…';
}

function sanitizeText(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}
