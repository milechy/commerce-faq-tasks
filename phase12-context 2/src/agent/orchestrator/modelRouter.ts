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
