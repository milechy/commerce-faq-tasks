// src/agent/tools/synthesisTool.ts

import { GPT_OSS_120B } from '../../config/groqModels';
import type { RerankItem } from '../types';
import { groqClient, type GroqUsage } from '../llm/groqClient';
import {
  getActiveRulesForTenant,
  buildTuningPromptSection,
} from '../../api/admin/tuning/tuningRulesRepository';
import { matchesTriggerPattern } from '../../api/admin/tuning/triggerMatching';
import type { PrincipleChunk } from '../psychology/principleSearch';
import { selectVariant, type PromptVariant } from '../ab-test/variantSelector';
import type { BehaviorContext } from '../../api/events/behaviorContext';
import { formatBehaviorContextForPrompt } from '../../api/events/behaviorContext';
import type { SimilarPattern } from '../../api/events/similarUserMatcher';

import { getPool } from '../../lib/db';
import { buildSentimentHint } from '../../lib/sentiment/hint';
import { RAG_EXCERPT_MAX_CHARS, RAG_MAX_EXCERPTS } from '../config/ragLimits';

// GID 1216978855735482 → GID 1216978677398163(P3): sessionIdのハッシュによる
// 疑似sticky(hashToUnitInterval)ではなく、chat_sessions.prompt_variant_id に
// 記録済みの割当を直接読んで使う「真のsticky」にする。
//
// ハッシュ方式の限界: variantの並び順(累積walkが配列順に依存)やweight設定を
// 変更すると、同じ stickyKey でも選ばれるvariantが変わりうる。すると
// 「chat_sessions.prompt_variant_id に記録された値」と「実際にこのターンで
// 使われたプロンプト」が乖離し、A/B分析が実際の挙動と異なるvariantに
// 結果を帰属させてしまう。DBの記録を真実の情報源にすることでこれを避ける。
//
// 記録済みのvariantIdが現在のsystem_prompt_variantsに存在しない場合
// (variant削除・IDリネーム)は、そのvariantを再現できないためハッシュ選択に
// フォールバックする(初回選択時と同じ経路)。
async function getTenantsPromptWithVariant(tenantId: string, sessionId?: string): Promise<{
  prompt: string | null;
  variantId: string | null;
  variantName: string | null;
}> {
  try {
    const pool = getPool();

    const result = sessionId
      ? await pool.query<{
          system_prompt: string | null;
          system_prompt_variants: PromptVariant[] | null;
          recorded_variant_id: string | null;
        }>(
          `SELECT t.system_prompt, t.system_prompt_variants, cs.prompt_variant_id AS recorded_variant_id
             FROM tenants t
             LEFT JOIN chat_sessions cs ON cs.tenant_id = t.id AND cs.session_id = $2
            WHERE t.id = $1`,
          [tenantId, sessionId],
        )
      : await pool.query<{
          system_prompt: string | null;
          system_prompt_variants: PromptVariant[] | null;
          recorded_variant_id: string | null;
        }>(
          'SELECT system_prompt, system_prompt_variants, NULL AS recorded_variant_id FROM tenants WHERE id = $1',
          [tenantId],
        );
    const row = result.rows[0];
    if (!row) return { prompt: null, variantId: null, variantName: null };

    const variants = row.system_prompt_variants ?? [];
    const fallback = row.system_prompt?.trim() ?? '';

    // 記録済みの割当が現在のvariant一覧にまだ存在すれば、それをそのまま使う
    // (ハッシュを再計算しない = 並び順・weight変更の影響を受けない)。
    if (row.recorded_variant_id) {
      const recorded = variants.find((v) => v.id === row.recorded_variant_id);
      if (recorded) {
        return { prompt: recorded.prompt || null, variantId: recorded.id, variantName: recorded.name };
      }
    }

    // 初回ターン、または記録済みvariantが削除済みの場合はハッシュで選択する
    // (この結果が saveMessage 経由で chat_sessions.prompt_variant_id に
    // COALESCE書き込みされ、以降のターンで上の分岐から読まれるようになる)。
    const selection = selectVariant(variants, fallback, sessionId);
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
  /** Phase57: 訪問者行動コンテキスト */
  behaviorContext?: BehaviorContext | null;
  /** Phase57: 類似コンバージョンパターン */
  similarPatterns?: SimilarPattern[];
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
  /**
   * GID 1216978855735482 (PR-14): 応答生成に実際に反映された tuning_rules の id。
   * chat_messages.metadata.applied_rule_ids に記録し、ルール効果測定(ruleEffect.ts)の
   * 母集団判定に使う。マッチしただけで応答に反映されなかった経路(fallbackSynthesize)では
   * 含めない。
   */
  appliedRuleIds?: number[];
  /** Phase53: Groq API実トークン数（取得できた場合のみ） */
  llmUsage?: GroqUsage;
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

// 検索ヒットが0件のときに顧客へ返す定型メッセージ。
// GROQ_API_KEY 未設定時・LLM呼び出し失敗時・チューニングルールが1件も無いときの
// 3箇所で同じ文言を使う(2つ目の文言を作らない)。
const NO_MATCH_MESSAGE =
  'ご質問の内容に完全に一致するFAQは見つかりませんでした。' +
  'キーワード（商品名・機能名・「返品」「送料」など）を含めて、もう一度お試しください。';

// 検索ヒット0件・チューニングルールのみ一致のときにLLMへ渡す接地ブロック。
// このブロックが無いと、faqContext='' のまま LLM が呼ばれ、応答ルール
// (expected_behavior は「方針」であって「事実」ではない)だけを根拠に
// 事実の主張(価格・在庫・仕様・期間・保証など)を生成しうる。
// 3層モデル(FAQ=事実 / expected_behavior=方針 / approved_responses=文体)を
// 守るため、ヒット0件のときは事実の生成そのものを禁じる。
const NO_GROUNDING_BLOCK = `【重要: このご質問に一致する参照可能な知識がありません】
- 価格・在庫・仕様・期間・保証などの事実を、推測や一般論で答えてはいけません
- 上記の応答ルールは文体・案内の仕方にのみ適用し、事実の代わりに使ってはいけません
- 「恐れ入りますが、こちらでは正確にお答えできる情報がございません」のように伝え、
  問い合わせ窓口へ案内してください`;

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
 * Groq LLM（openai/gpt-oss-120b）で自然な日本語回答を生成する。
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
          // ナレッジ配線是正P13: `_topScore > 0 ? ... : undefined` だと
          // 実スコアがちょうど0.0のヒットが low_confidence 判定をすり抜けていた
          // (detectGap は no_rag→low_confidence の優先順位で判定するため、
          // hitCount===0 のケースは no_rag が先に拾う。0.0 をそのまま渡して問題ない)。
          topRerankScore: _topScore,
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
    ? await getTenantsPromptWithVariant(tenantId, input.sessionId)
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
    return { answer: truncate(NO_MATCH_MESSAGE, maxChars), gapSignal };
  }

  // Phase44: SalesFlow ステージが propose/recommend/close の場合のみ原則注入を準備
  const shouldInjectPrinciples =
    salesStage !== undefined && PRINCIPLE_STAGES.has(salesStage) && principleChunks.length > 0;

  // Groq APIキーがなければ即フォールバック（FAQ ヒットありの場合のみ）
  if (!process.env.GROQ_API_KEY) {
    if (!items.length) {
      // FAQ なし + チューニングルールあり だが LLM なし。
      // expected_behavior は内部の方針文であり顧客向けの文面ではないため、
      // そのまま返さず定型メッセージに差し替える(3層モデル: 方針を事実の代わりにしない)。
      return { answer: truncate(NO_MATCH_MESSAGE, maxChars), gapSignal, appliedRuleIds: matchedRules.map((r) => r.id) };
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
    // ヒット0件・チューニングルールのみ一致のとき、事実の生成を禁じる接地ブロックを注入する
    if (!items.length) {
      systemPromptParts.push(NO_GROUNDING_BLOCK);
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
    // Phase57: 訪問者行動コンテキスト注入
    if (input.behaviorContext) {
      systemPromptParts.push(formatBehaviorContextForPrompt(input.behaviorContext));
    }
    // Phase57: 類似コンバージョンパターン注入
    if (input.similarPatterns && input.similarPatterns.length > 0) {
      const patternLines = ['## 類似お客様の成功パターン'];
      for (const p of input.similarPatterns) {
        let line = `- 類似度${Math.round(p.similarity * 100)}%のお客様: ${p.conversionType}でコンバージョン`;
        if (p.principlesUsed.length > 0) {
          line += `（使用原則: ${p.principlesUsed.join('、')}）`;
        }
        patternLines.push(line);
      }
      systemPromptParts.push(patternLines.join('\n'));
    }
    const systemPrompt = systemPromptParts.join('\n\n');

    // FAQ コンテキスト（ヒットがある場合）
    // 書籍著作権保護: 1件あたり RAG_EXCERPT_MAX_CHARS 文字までに切り詰める
    // (src/agent/config/ragLimits.ts)。テキストをそのままLLMへ渡すと、
    // 書籍由来チャンク(metadata.source='book')の全文がプロンプトに乗ってしまう。
    const faqContext = items.length
      ? items
          .slice(0, RAG_MAX_EXCERPTS)
          .map((it, i) => {
            const excerpt = truncate(sanitizeText(it.text), RAG_EXCERPT_MAX_CHARS);
            return `FAQ${i + 1}:\nQ: ${excerpt}\nA: ${excerpt}`;
          })
          .join('\n\n')
      : '';

    const userPrompt = faqContext
      ? `お客様の質問: ${query}\n参考FAQ:\n${faqContext}\n上記のFAQ情報をもとに、お客様の質問に自然な日本語で回答してください。`
      : `お客様の質問: ${query}\n上記の応答ルールに従って、お客様の質問に自然な日本語で回答してください。`;

    const synthResult = await groqClient.callWithUsage({
      model: GPT_OSS_120B,
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
      answer: truncate(synthResult.content.trim(), maxChars),
      gapSignal,
      llmUsage: synthResult.usage,
      variantId: selectedVariantId,
      variantName: selectedVariantName,
      appliedRuleIds: matchedRules.length > 0 ? matchedRules.map((r) => r.id) : undefined,
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
      // 上と同じ理由で expected_behavior を顧客にそのまま返さない
      return { answer: truncate(NO_MATCH_MESSAGE, maxChars), gapSignal, appliedRuleIds: matchedRules.map((r) => r.id) };
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
