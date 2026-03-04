/**
 * lib/groq.ts
 *
 * Groq モデルルーティング層。
 * - complexity <= 0.7: llama-3.1-8b-instant（高速・低コスト）
 * - complexity > 0.7 : llama-3.3-70b-versatile（高精度）
 *
 * コスト制約: 月 $27-48 以内（8B をデフォルト、70B は最小限に）
 */

import type { GroqModel } from "../types/contracts";

export const GROQ_MODEL_FAST: GroqModel = "llama-3.1-8b-instant";
export const GROQ_MODEL_QUALITY: GroqModel = "llama-3.3-70b-versatile";

/** complexity > 0.7 で 70B にルーティングするしきい値 */
const COMPLEXITY_THRESHOLD = 0.7;

export interface GroqRouteResult {
  model: GroqModel;
  routing: "fast" | "quality";
  reason: string;
}

/**
 * complexity スコアに基づいてモデルを選択する。
 *
 * @param complexity 0.0〜1.0 の複雑度スコア
 */
export function resolveGroqModel(complexity: number): GroqRouteResult {
  if (complexity > COMPLEXITY_THRESHOLD) {
    return {
      model: GROQ_MODEL_QUALITY,
      routing: "quality",
      reason: `complexity=${complexity.toFixed(2)} > ${COMPLEXITY_THRESHOLD}`,
    };
  }
  return {
    model: GROQ_MODEL_FAST,
    routing: "fast",
    reason: `complexity=${complexity.toFixed(2)} <= ${COMPLEXITY_THRESHOLD}`,
  };
}

// ---------------------------------------------------------------------------
// Groq Chat Completion
// ---------------------------------------------------------------------------

export interface GroqChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GroqCallOptions {
  /** 0.0〜1.0 の複雑度スコア。省略時は 0（8B 固定） */
  complexity?: number;
  temperature?: number;
  /** 8B: 256, 70B: 320 — コスト・p95 抑制のため上限を設ける */
  maxTokens?: number;
  /** ログ集計用タグ */
  tag?: string;
}

export interface GroqCallResult {
  text: string;
  model: GroqModel;
  routing: "fast" | "quality";
  latencyMs: number;
}

/**
 * Groq Chat Completion を呼び出す。
 *
 * - complexity に基づいてモデルを自動選択
 * - maxTokens 省略時は routing に応じたデフォルトを適用（8B=256, 70B=320）
 * - 書籍 RAG コンテキストを直接 messages に含める場合は
 *   呼び出し元で ragExcerpt.slice(0, 200) を適用すること
 */
export async function callGroq(
  messages: GroqChatMessage[],
  options: GroqCallOptions = {},
): Promise<GroqCallResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set");
  }

  const complexity = options.complexity ?? 0;
  const { model, routing, reason } = resolveGroqModel(complexity);

  const defaultMaxTokens = routing === "quality" ? 320 : 256;
  const maxTokens = options.maxTokens ?? defaultMaxTokens;

  const t0 = Date.now();

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options.temperature ?? 0,
      max_tokens: maxTokens,
    }),
  });

  const latencyMs = Date.now() - t0;

  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 300);
    throw new GroqRoutingError(
      `Groq API error: status=${res.status}`,
      res.status,
      snippet,
      model,
      routing,
    );
  }

  const json: unknown = await res.json();
  const content =
    (json as { choices?: { message?: { content?: string } }[] })
      ?.choices?.[0]?.message?.content;

  if (typeof content !== "string") {
    throw new Error(
      `Groq API: no content in response (model=${model}, routing=${routing}, reason=${reason})`,
    );
  }

  return { text: content, model, routing, latencyMs };
}

export class GroqRoutingError extends Error {
  readonly status: number;
  readonly bodySnippet: string;
  readonly model: GroqModel;
  readonly routing: "fast" | "quality";

  constructor(
    message: string,
    status: number,
    bodySnippet: string,
    model: GroqModel,
    routing: "fast" | "quality",
  ) {
    super(message);
    this.name = "GroqRoutingError";
    this.status = status;
    this.bodySnippet = bodySnippet;
    this.model = model;
    this.routing = routing;
  }
}

// ---------------------------------------------------------------------------
// Complexity estimator（軽量ルールベース）
// ---------------------------------------------------------------------------

/**
 * テキストの複雑度を 0.0〜1.0 で推定する簡易ルールベース実装。
 *
 * Phase12 の Fast-path 判定ロジックと整合させる。
 * 本実装では LLM を呼ばないため、Planner コストに影響しない。
 */
export function estimateComplexity(text: string): number {
  const t = text.toLowerCase();

  // 比較・推薦系（高複雑度）
  const highComplexityPatterns = [
    /比較/,
    /一番お得/,
    /どっちが/,
    /どちらが/,
    /おすすめ/,
    /ランキング/,
    /違いを教え/,
    /メリット.*デメリット/,
    /compare/i,
    /which is better/i,
    /recommend/i,
  ];

  // 単純 FAQ（低複雑度）
  const lowComplexityPatterns = [
    /営業時間/,
    /支払い方法/,
    /返品.*ポリシー/,
    /配送.*日数/,
    /電話番号/,
    /住所/,
    /how do i pay/i,
    /business hours/i,
    /return policy/i,
  ];

  let score = 0.4; // ベースライン

  for (const p of highComplexityPatterns) {
    if (p.test(t)) {
      score += 0.15;
    }
  }

  for (const p of lowComplexityPatterns) {
    if (p.test(t)) {
      score -= 0.15;
    }
  }

  // 文字数でも若干補正（長い質問は複雑度が上がりがち）
  if (text.length > 200) score += 0.1;
  if (text.length > 400) score += 0.1;

  return Math.max(0, Math.min(1, score));
}
