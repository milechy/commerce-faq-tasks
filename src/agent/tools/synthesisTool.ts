// src/agent/tools/synthesisTool.ts

import type { RerankItem } from '../types';
import { groqClient } from '../llm/groqClient';
import {
  getActiveRulesForTenant,
  buildTuningPromptSection,
  getTenantSystemPrompt,
} from '../../api/admin/tuning/tuningRulesRepository';

export interface SynthesisInput {
  query: string;
  items: RerankItem[];
  maxChars?: number;
  /** Phase38 Step5: チューニングルール注入のためのテナントID */
  tenantId?: string;
}

export interface SynthesisOutput {
  answer: string;
}

const DEFAULT_MAX_CHARS = 420;

/**
 * ベースシステムプロンプト（汎用化 — テナント固有の業種記述を除去）。
 * Phase38 Step5 でチューニングルールを動的に末尾に追加する。
 */
const BASE_SYSTEM_PROMPT = `あなたは営業支援AIアシスタントです。
お客様の質問に対して、提供されたFAQデータベースの情報をもとに
親切で自然な日本語で回答し、商品やサービスへの関心を高めてください。
ルール:
- 回答は200文字以内で簡潔に
- FAQにない情報は推測で答えない
- 敬語を使う
- 箇条書きではなく自然な文章で答える
- FAQ情報が不十分な場合は「詳しくはお問い合わせください」と案内する`;

/**
 * システムプロンプトを構築する。優先順位:
 *   1. tenants.system_prompt（テナント固有、空でなければ上書き）
 *   2. BASE_SYSTEM_PROMPT（汎用フォールバック）
 *   + チューニングルール（tuning_rules）を末尾に追加
 *
 * DB取得失敗時はベースプロンプトのみを返す（チャットを止めない）。
 * // TODO: cache tuning rules per tenant (TTL 5min) for performance
 */
async function buildSystemPrompt(tenantId?: string): Promise<string> {
  if (!tenantId) return BASE_SYSTEM_PROMPT;

  try {
    // Phase38 Step6: テナント固有 system_prompt を読む（上書き）
    const [tenantPrompt, rules] = await Promise.all([
      getTenantSystemPrompt(tenantId),
      getActiveRulesForTenant(tenantId),
    ]);

    const basePrompt = tenantPrompt ?? BASE_SYSTEM_PROMPT;
    const tuningSection = buildTuningPromptSection(rules);
    return tuningSection ? `${basePrompt}\n\n${tuningSection}` : basePrompt;
  } catch (err) {
    console.warn('[tuning] failed to load system prompt:', err);
    return BASE_SYSTEM_PROMPT;
  }
}

/**
 * Groq LLM（llama-3.3-70b-versatile）で自然な日本語回答を生成する。
 * APIキー未設定・エラー時は箇条書きフォールバックを返す。
 * Phase38 Step5: tenantId を受け取り、チューニングルールをシステムプロンプトに動的注入。
 */
export async function synthesizeAnswer(input: SynthesisInput): Promise<SynthesisOutput> {
  const { query, items, maxChars = DEFAULT_MAX_CHARS, tenantId } = input;

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
    // Phase38 Step5: チューニングルールを動的注入
    const systemPrompt = await buildSystemPrompt(tenantId);

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
