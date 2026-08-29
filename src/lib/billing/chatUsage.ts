// src/lib/billing/chatUsage.ts
//
// chat 型（LLM 合成 + RAG + query 埋め込み）の実 usage を trackUsage の
// パラメータに変換する共通ヘルパ。
//
// もともと src/api/chat/route.ts の中だけにインラインで書かれていた抽出ロジック
// （llmUsage=synthesis を chat モデルで、plannerLlmUsages / embeddingUsage を
// extraLlmUsages に実モデル単価で内包する）を、同じ合成経路を通す他の
// HTTP エンドポイント（POST /dialog/turn, /agent.search, /agent/search）でも
// 一字一句同じ計上ができるように切り出したもの。
//
// ★二重計上について★
//   /api/chat は内部で runDialogTurn / runSearchAgent を呼ぶが、trackUsage は
//   /api/chat のハンドラ側で1回だけ呼ぶ。このヘルパは runDialogTurn /
//   runSearchAgent の「HTTP 直エンドポイント」（/dialog/turn, /agent.search）の
//   ハンドラでのみ使う。合成関数の内部には仕込まないため、chat 経路の計上は
//   現状のまま二重計上にならない。
//
// PR-2(2026-08-25収益監査)の設計を踏襲:
//   - synthesis(chat LLM) は本行の model=CHAT_LLM_MODEL / input/output で計上。
//   - planner LLM(GPT-OSS 20B/120B)と query 埋め込み(OpenAI)は chat とは別単価の
//     ため合算せず extraLlmUsages に実モデル名で内包する（別 usage_log は作らず
//     Stripe の請求リクエスト数=COUNT(*) を保つ）。

import { GPT_OSS_120B } from "../../config/groqModels";

/**
 * chat 本体（synthesis）の課金モデル。api/chat/route.ts と同じ既定に合わせる。
 * LLM_CHAT_MODEL が未設定なら GPT_OSS_120B。
 */
export const CHAT_LLM_MODEL = process.env.LLM_CHAT_MODEL ?? GPT_OSS_120B;

/**
 * runDialogTurn / runSearchAgent の meta から拾える usage 断片。
 * DialogTurnMeta / AgentSearchResponse の該当フィールドと構造互換。
 */
export interface ChatLikeUsageMeta {
  /** synthesis(chat LLM)の実トークン。CHAT_LLM_MODEL レートで課金。 */
  llmUsage?: { prompt_tokens: number; completion_tokens: number };
  /** query 埋め込み(OpenAI)のトークン。chat とは別単価のため extraLlmUsages に内包。 */
  embeddingUsage?: { model: string; totalTokens: number };
  /** マルチステップ planner LLM のモデル別 usage。chat とは別単価のため内包。 */
  plannerLlmUsages?: Array<{
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
  }>;
}

/** trackUsage() に渡す usage 部分（tenantId / requestId / sessionId 等は呼び出し側で付与）。 */
export interface ChatUsageTracking {
  model: string;
  inputTokens: number;
  outputTokens: number;
  extraLlmUsages?: Array<{ model: string; inputTokens: number; outputTokens: number }>;
}

/**
 * meta（llmUsage / embeddingUsage / plannerLlmUsages）から trackUsage の
 * usage 部分を構築する。chat/route.ts:605-642 と同一のルール。
 *
 * synthesis 未実行（GROQ キー無し / fallback / エラー）でも llmUsage は {0,0} と
 * なり「chat 実トークン 0」を表す。extraLlmUsages は inputTokens>0 の項目のみ残す。
 */
export function buildChatUsageTracking(
  meta: ChatLikeUsageMeta | undefined
): ChatUsageTracking {
  const llmUsage = meta?.llmUsage ?? { prompt_tokens: 0, completion_tokens: 0 };
  const embeddingUsage = meta?.embeddingUsage;

  const extraLlmUsages = [
    ...(meta?.plannerLlmUsages ?? [])
      .filter((pu) => pu.prompt_tokens > 0 || pu.completion_tokens > 0)
      .map((pu) => ({
        model: pu.model,
        inputTokens: pu.prompt_tokens,
        outputTokens: pu.completion_tokens,
      })),
    ...(embeddingUsage && embeddingUsage.totalTokens > 0
      ? [{ model: embeddingUsage.model, inputTokens: embeddingUsage.totalTokens, outputTokens: 0 }]
      : []),
  ];

  return {
    model: CHAT_LLM_MODEL,
    inputTokens: llmUsage.prompt_tokens,
    outputTokens: llmUsage.completion_tokens,
    ...(extraLlmUsages.length > 0 ? { extraLlmUsages } : {}),
  };
}
