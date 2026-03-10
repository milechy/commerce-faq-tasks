// src/agent/tools/synthesisTool.ts

import type { RerankItem } from '../types';
import { groqClient } from '../llm/groqClient';

export interface SynthesisInput {
  query: string;
  items: RerankItem[];
  maxChars?: number;
}

export interface SynthesisOutput {
  answer: string;
}

const DEFAULT_MAX_CHARS = 420;

const SYSTEM_PROMPT = `あなたは中古車販売店のAIコンシェルジュです。
お客様の質問に対して、提供されたFAQ情報をもとに
親切で自然な日本語で回答してください。
ルール:
- 回答は200文字以内で簡潔に
- FAQにない情報は推測で答えない
- 敬語を使う
- 箇条書きではなく自然な文章で答える
- FAQ情報が不十分な場合は「詳しくはお問い合わせください」と案内する`;

/**
 * Groq LLM（llama-3.3-70b-versatile）で自然な日本語回答を生成する。
 * APIキー未設定・エラー時は箇条書きフォールバックを返す。
 */
export async function synthesizeAnswer(input: SynthesisInput): Promise<SynthesisOutput> {
  const { query, items, maxChars = DEFAULT_MAX_CHARS } = input;

  if (!items.length) {
    const msg =
      'ご質問の内容に完全に一致するFAQは見つかりませんでした。' +
      'キーワード（商品名・機能名・「返品」「送料」など）を含めて、もう一度お試しください。';
    return { answer: truncate(msg, maxChars) };
  }

  // Groq APIキーがなければ即フォールバック
  if (!process.env.GROQ_API_KEY) {
    return fallbackSynthesize(input);
  }

  try {
    const top3 = items.slice(0, 3);
    const faqContext = top3
      .map((it, i) => `FAQ${i + 1}:\nQ: ${sanitizeText(it.text)}\nA: ${sanitizeText(it.text)}`)
      .join('\n\n');

    const userPrompt =
      `お客様の質問: ${query}\n参考FAQ:\n${faqContext}\n` +
      '上記のFAQ情報をもとに、お客様の質問に自然な日本語で回答してください。';

    const raw = await groqClient.call({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.5,
      maxTokens: 300,
      tag: 'synthesis',
    });

    return { answer: truncate(raw.trim(), maxChars) };
  } catch {
    // フォールバック: 箇条書き
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
