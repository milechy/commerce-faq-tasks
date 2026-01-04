// src/agent/llm/openaiEmbeddingClient.ts
// OpenAI Embeddings を REST API 経由で呼ぶラッパー（SDK 不使用）

export async function embedText(text: string): Promise<number[]> {
  // In test mode, avoid calling external OpenAI API and return a dummy vector.
  if (process.env.NODE_ENV === "test") {
    // 1536-dim dummy embedding (matches text-embedding-3-* default size)
    return Array.from({ length: 1536 }, () => Math.random());
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const model = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";

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

  const json: any = await res.json();
  const embedding = json?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error("OpenAI embedding not found in response");
  }

  // 念のため number 配列に正規化
  return embedding.map((v: any) =>
    typeof v === "number" ? v : Number(v) || 0
  );
}

// Backward compatibility: older code expects embedTextOpenAI()
export async function embedTextOpenAI(text: string): Promise<number[]> {
  return embedText(text);
}
// src/agent/llm/modelRouter.ts
// Phase8: lightweight routing model for planner / answer models (20B / 120B)

export type PlannerRoute = '20b' | '120b';

/**
 * RouteContextV2
 *
 * LangGraph / dialog orchestrator から渡される、
 * 「このターンの複雑さ・安全性・コンテキスト長」などのシグナル。
 *
 * すべて optional にしておき、呼び出し側で持っているものだけ埋める前提。
 */
export interface RouteContextV2 {
  contextTokens?: number | null;
  recall?: number | null;
  complexity?: 'low' | 'medium' | 'high';
  safetyTag?: string | null;
  conversationDepth?: number;
  used120bCount?: number;
  max120bPerRequest?: number;
  intentType?: string;
  requiresSafeMode?: boolean;
}

export interface PlannerRoutingDecision {
  route: PlannerRoute;
  reasons: string[];
  used120bCount: number;
  max120bPerRequest?: number;
}

/**
 * v2 routing model
 *
 * - requiresSafeMode が true の場合は常に 120B
 * - conversationDepth / complexity / contextTokens からざっくり複雑さを見て 120B を選ぶ
 * - used120bCount / max120bPerRequest で「1リクエスト内では 120B の回数を抑える」
 */
export function routePlannerModelV2(ctx: RouteContextV2): PlannerRoutingDecision {
  const reasons: string[] = [];

  const used120bCount = ctx.used120bCount ?? 0;
  const max120bPerRequest = ctx.max120bPerRequest ?? 1;
  const depth = ctx.conversationDepth ?? 0;
  const tokens = ctx.contextTokens ?? 0;
  const complexity = ctx.complexity ?? 'medium';
  const requiresSafeMode = !!ctx.requiresSafeMode;

  let route: PlannerRoute = '20b';

  if (requiresSafeMode) {
    route = '120b';
    reasons.push('safety:requires-safe-mode');
  } else {
    // context size based routing
    if (tokens > 2048) {
      route = '120b';
      reasons.push('context-tokens-high');
    }

    // deep conversation
    if (depth > 6) {
      route = '120b';
      reasons.push('conversation-depth-high');
    }

    // heuristic based on complexity
    if (complexity === 'high') {
      route = '120b';
      reasons.push('complexity-high');
    }
  }

  // budget for 120B usage
  if (route === '120b' && used120bCount >= max120bPerRequest) {
    // exceed budget → fall back to 20B, but keep reason for observability
    route = '20b';
    reasons.push('budget:120b-usage-cap-reached');
  }

  const nextUsed120b =
    route === '120b' ? used120bCount + 1 : used120bCount;

  if (reasons.length === 0) {
    reasons.push('default:20b');
  }

  return {
    route,
    reasons,
    used120bCount: nextUsed120b,
    max120bPerRequest,
  };
}

// Backwards compatibility exports (in case older code imports these names)
export type PlannerRoutingDecisionV2 = PlannerRoutingDecision;
export type RouteContext = RouteContextV2;
export const routePlannerModel = routePlannerModelV2;
