// src/agent/llm/openaiEmbeddingClient.ts
// OpenAI Embeddings を REST API 経由で呼ぶラッパー（SDK 不使用）

import { trackUsage } from "../../lib/billing/usageTracker";
import { logger } from "../../lib/logger";

export interface EmbedTextResult {
  embedding: number[];
  /** OpenAI total_tokens（課金合算用）。テストモードでは 0。 */
  totalTokens: number;
  /** 実際に使用した埋め込みモデル名（呼び出し元が extraLlmUsages 等に単価計算用として使う）。 */
  model: string;
}

/**
 * 呼び出し元がテナントコンテキストを持つ場合に渡す（省略可）。
 * 省略時も trackUsage は必ず計上する（tenantId="unknown" / billable=false）—
 * 呼び出し元を横断して埋め込みコストが一切計上されていなかったため、
 * 帰属先が未確定でも「原価が見える」状態を優先する。
 */
export interface EmbedUsageContext {
  tenantId?: string;
  requestId?: string;
  /**
   * PR-2(2026-08-25収益監査): true の場合、この呼び出し自体の trackUsage を
   * 完全にスキップする。呼び出し元が別の trackUsage 呼び出し(extraLlmUsages 等)で
   * 同じトークンを既に計上する場合に使う(二重計上・請求数量の水増し防止)。
   * 例: チャット応答の embedding は chat 行の extraLlmUsages に内包するため
   * ここでは行を作らない(searchAgent.ts)。書籍OCRのチャンク埋め込みは
   * ジョブ単位の集計行に内包するため同様(ocrPipeline.ts)。
   */
  skipTracking?: boolean;
  /**
   * billable を明示的に上書きする。省略時は tenantId 有無から自動判定
   * (tenantId 有=true、tenantId 無=false)。課金対象化の方針が未確定な
   * 単独の埋め込み呼び出しは false を明示し、原価の可視化のみに留める。
   */
  billable?: boolean;
}

export async function embedTextWithUsage(
  text: string,
  usageContext?: EmbedUsageContext,
): Promise<EmbedTextResult> {
  const model = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";

  if (process.env.NODE_ENV === "test") {
    return {
      embedding: Array.from({ length: 1536 }, () => Math.random()),
      totalTokens: 0,
      model,
    };
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    const snippet = body.length > 300 ? `${body.slice(0, 300)}...` : body;
    throw new Error(`OpenAI embeddings failed: ${res.status} ${snippet}`);
  }

  const json = await res.json() as {
    data?: Array<{ embedding?: unknown[] }>;
    usage?: { total_tokens?: number };
  };
  const embedding = json?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error("OpenAI embedding not found in response");
  }

  const totalTokens = json?.usage?.total_tokens ?? 0;

  // 呼び出し元がtenantIdを渡していない場合は帰属先不明として billable=false で
  // 原価のみ記録する（誤って"unknown"テナントへ請求しないため）。
  // skipTracking=true の場合は呼び出し元が別のtrackUsage呼び出しで既にこのトークンを
  // 計上する(二重計上防止。PR-2)ため、ここでは行を作らない。
  // trackUsageは現状setImmediateでスケジュールするだけの同期voidだが、将来の実装変更で
  // 同期例外を投げるようになっても、正常取得できたembedding結果を道連れにしないよう
  // 明示的に隔離する（CLAUDE.md: 副作用の記録の失敗が応答を変えてはならない）。
  if (!usageContext?.skipTracking) {
    try {
      trackUsage({
        tenantId: usageContext?.tenantId ?? "unknown",
        requestId: usageContext?.requestId ?? `embed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        model,
        inputTokens: totalTokens,
        outputTokens: 0,
        featureUsed: "admin_guide",
        billable: usageContext?.billable ?? (usageContext?.tenantId ? undefined : false),
      });
    } catch (err) {
      logger.warn({ err }, "embedTextWithUsage: trackUsage failed (non-blocking)");
    }
  }

  return {
    embedding: embedding.map((v) => (typeof v === "number" ? v : Number(v) || 0)),
    totalTokens,
    model,
  };
}

export async function embedText(text: string, usageContext?: EmbedUsageContext): Promise<number[]> {
  const { embedding } = await embedTextWithUsage(text, usageContext);
  return embedding;
}

// Backward compatibility: older code expects embedTextOpenAI()
export async function embedTextOpenAI(text: string, usageContext?: EmbedUsageContext): Promise<number[]> {
  return embedText(text, usageContext);
}
