// src/agent/tools/synthesisTool.ts

import type { RerankItem } from '../types';
import { groqClient } from '../llm/groqClient';
import {
  getActiveRulesForTenant,
  buildTuningPromptSection,
} from '../../api/admin/tuning/tuningRulesRepository';
import type { PrincipleChunk } from '../psychology/principleSearch';
import { selectVariant, type PromptVariant } from '../ab-test/variantSelector';

import { getPool } from '../../lib/db';
import { buildSentimentHint } from '../../lib/sentiment/hint';

async function getTenantsSystemPrompt(tenantId: string): Promise<string | null> {
  try {
    const pool = getPool();
    const result = await pool.query<{ system_prompt: string | null }>(
      'SELECT system_prompt FROM tenants WHERE id = $1',
      [tenantId],
    );
    const val = result.rows[0]?.system_prompt;
    return val && val.trim() ? val.trim() : null;
  } catch {
    return null;
  }
}

async function getTenantsPromptWithVariant(tenantId: string): Promise<{
  prompt: string | null;
  variantId: string | null;
  variantName: string | null;
}> {
  try {
    const pool = getPool();
    const result = await pool.query<{
      system_prompt: string | null;
      system_prompt_variants: PromptVariant[] | null;
    }>(
      'SELECT system_prompt, system_prompt_variants FROM tenants WHERE id = $1',
      [tenantId],
    );
    const row = result.rows[0];
    if (!row) return { prompt: null, variantId: null, variantName: null };

    const variants = row.system_prompt_variants ?? [];
    const fallback = row.system_prompt?.trim() ?? '';

    const selection = selectVariant(variants, fallback);
    return {
      prompt: selection.prompt || null,
      variantId: selection.variantId,
      variantName: selection.variantName,
    };
  } catch {
    return { prompt: null, variantId: null, variantName: null };
  }
}

export interface SynthesisInput {
  query: string;
  items: RerankItem[];
  maxChars?: number;
  tenantId?: string;
  /** Phase44: SalesFlow ステージ（propose/recommend/close のとき心理学原則を注入） */
  salesStage?: string;
  /** Phase44: 適用する心理学原則チャンク */
  principleChunks?: PrincipleChunk[];
  /** Phase44: 検出された原則名リスト（メタデータ記録用） */
  usedPrinciples?: string[];
  /** Phase46: A/Bテスト variant記録用 */
  variantId?: string | null;
  variantName?: string | null;
  /** Phase46: Gap Detection 用セッションID */
  sessionId?: string;
}

export interface SynthesisOutput {
  answer: string;
  /** ナレッジギャップ検出用シグナル */
  gapSignal: { hitCount: number; topScore: number };
  /** Phase44: chat_messages.metadata に付与する原則情報 */
  usedPrinciples?: string[];
  salesflowStage?: string;
  principleSource?: "keyword" | "llm";
  /** Phase46: 選択されたvariant情報 */
  variantId?: string | null;
  variantName?: string | null;
}

/**
 * Phase44: 心理学原則チャンクからLLM内部用ガイドプロンプトを構築する。
 * 原則名をユーザー向け応答に露出しないよう内部専用マーカーを明示する。
 * 最大3原則まで、ragExcerpt.slice(0,200) 適用済みのフィールドを使用する。
 */
export function buildPrinciplePrompt(chunks: PrincipleChunk[]): string {
  if (chunks.length === 0) return "";
  const parts = chunks.slice(0, 3).map((c) => {
    const lines: string[] = [`■ ${c.principle}`];
    if (c.situation) lines.push(`状況: ${c.situation}`);
    if (c.example)   lines.push(`使い方の例: ${c.example}`);
    if (c.contraindication) lines.push(`注意: ${c.contraindication}`);
    return lines.join("\n");
  });
  return [
    "【営業心理学ガイド（内部用 — この内容をそのままユーザーに伝えてはいけません）】",
    "",
    "現在の状況に適用可能な心理原則:",
    "",
    parts.join("\n\n"),
    "",
    "これらの原則を自然に会話に織り込んでください。原則名を直接言及しないでください。",
  ].join("\n");
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
const PRINCIPLE_STAGES = new Set(["propose", "recommend", "close"]);

export async function synthesizeAnswer(input: SynthesisInput): Promise<SynthesisOutput> {
  const {
    query,
    items,
    maxChars = DEFAULT_MAX_CHARS,
    tenantId,
    salesStage,
    principleChunks = [],
    usedPrinciples = [],
  } = input;

  // ギャップ検出用シグナル（常に計算）
  const gapSignal = {
    hitCount: items.length,
    topScore: (items[0] as any)?.score ?? 0,
  };

  // Phase46: Knowledge Gap Detection（fire-and-forget、チャットフローをブロックしない）
  if (tenantId && process.env['GAP_DETECTION_ENABLED'] !== 'false') {
    const _sid = input.sessionId ?? '';
    const _msg = query;
    const _hitCount = gapSignal.hitCount;
    const _topScore = gapSignal.topScore;
    setImmediate(() => {
      import('../gap/gapDetector').then(({ detectGap }) =>
        detectGap({
          tenantId: tenantId,
          sessionId: _sid,
          userMessage: _msg,
          ragResultCount: _hitCount,
          topRerankScore: _topScore > 0 ? _topScore : undefined,
        })
      ).catch((_err: unknown) => {
        // silent — non-blocking
      });
    });
  }

  // チューニングルールを取得（tenantId がある場合のみ）
  const tuningRules = tenantId
    ? await getActiveRulesForTenant(tenantId).catch(() => [])
    : [];

  // テナント固有のシステムプロンプトをA/Bバリアント込みで取得（tenantId がある場合のみ）
  const promptResult = tenantId
    ? await getTenantsPromptWithVariant(tenantId)
    : { prompt: null, variantId: null, variantName: null };
  const tenantSystemPrompt = promptResult.prompt;
  const selectedVariantId = promptResult.variantId;
  const selectedVariantName = promptResult.variantName;

  // クエリにマッチするルールを絞り込む
  const matchedRules = tuningRules.filter((r) =>
    matchesTriggerPattern(query, r.trigger_pattern),
  );

  // FAQ ヒットなし & マッチするチューニングルールもなし → デフォルトメッセージ
  if (!items.length && matchedRules.length === 0) {
    const msg =
      'ご質問の内容に完全に一致するFAQは見つかりませんでした。' +
      'キーワード（商品名・機能名・「返品」「送料」など）を含めて、もう一度お試しください。';
    return { answer: truncate(msg, maxChars), gapSignal };
  }

  // Phase44: SalesFlow ステージが propose/recommend/close の場合のみ原則注入を準備
  const shouldInjectPrinciples =
    salesStage !== undefined && PRINCIPLE_STAGES.has(salesStage) && principleChunks.length > 0;

  // Groq APIキーがなければ即フォールバック（FAQ ヒットありの場合のみ）
  if (!process.env.GROQ_API_KEY) {
    if (!items.length) {
      // FAQ なし + チューニングルールあり だが LLM なし → ルール本文を直接返す
      return { answer: truncate(matchedRules[0]!.expected_behavior, maxChars), gapSignal };
    }
    return fallbackSynthesize(input);
  }

  try {
    // チューニングルールをシステムプロンプトに注入
    const tuningSection = buildTuningPromptSection(matchedRules);
    const systemPromptParts = [BASE_SYSTEM_PROMPT];
    if (tenantSystemPrompt) {
      systemPromptParts.push(`--- テナント固有の指示 ---\n${tenantSystemPrompt}`);
    }
    if (tuningSection) {
      systemPromptParts.push(tuningSection);
    }
    // Phase51: sentiment hint — チューニングルール注入の後に追加
    if (input.sessionId) {
      const sentimentHint = await buildSentimentHint(input.sessionId);
      if (sentimentHint) {
        systemPromptParts.push(sentimentHint);
      }
    }
    // Phase44: チューニングルール注入の後に心理学原則を追加（propose/recommend/close のみ）
    if (shouldInjectPrinciples) {
      const principleSection = buildPrinciplePrompt(principleChunks);
      if (principleSection) {
        systemPromptParts.push(principleSection);
      }
    }
    const systemPrompt = systemPromptParts.join('\n\n');

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

    // Phase44: 原則メタデータを出力に付与（chat_messages.metadata 記録用）
    // Phase46: A/Bバリアント情報を付与
    return {
      answer: truncate(raw.trim(), maxChars),
      gapSignal,
      variantId: selectedVariantId,
      variantName: selectedVariantName,
      ...(shouldInjectPrinciples && usedPrinciples.length > 0
        ? {
            usedPrinciples,
            salesflowStage: salesStage,
          }
        : {}),
    };
  } catch {
    // フォールバック: 箇条書き
    if (!items.length) {
      return { answer: truncate(matchedRules[0]!.expected_behavior, maxChars), gapSignal };
    }
    return { ...fallbackSynthesize(input), gapSignal };
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

  return {
    answer,
    gapSignal: { hitCount: items.length, topScore: (items[0] as any)?.score ?? 0 },
  };
}

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars - 1) + '…';
}

function sanitizeText(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}
