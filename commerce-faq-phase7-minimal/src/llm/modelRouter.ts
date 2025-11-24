// src/llm/modelRouter.ts

export type SafetyTag = 'none' | 'legal' | 'security' | 'policy' | 'other'

export interface RouteContext {
  /**
   * トークン数（context length）。prompt + history + retrieved docs の合計想定。
   */
  contextTokens: number
  /**
   * RAG の recall 指標。0.0〜1.0 を想定。null の場合は「情報なし」扱い。
   */
  recall: number | null
  /**
   * 問い合わせの複雑度スコア。0.0〜1.0 を想定。null の場合は「情報なし」扱い。
   */
  complexity: number | null
  /**
   * 安全タグ（legal / security / policy など）。
   */
  safetyTag: SafetyTag
}

/**
 * ルーティング結果。
 * - "20b": 既定。コスト・レイテンシ優先。
 * - "120b": 昇格条件を満たした場合のみ。
 */
export type RoutedModel = '20b' | '120b'

/**
 * 20B/120B モデルルーティングルール。
 *
 * ARCHITECTURE.md / REQUIREMENTS.md の要件:
 * - 既定: 20B
 * - 昇格条件:
 *   - context_tokens > 2000
 *   - recall < 0.6
 *   - complexity >= τ
 *   - safety_tag ∈ {legal, security, policy}
 * - フォールバック: 20B 失敗 → 120B（1回限定）
 */
const COMPLEXITY_THRESHOLD = 0.7
const RECALL_THRESHOLD = 0.6

export function routePlannerModel(ctx: RouteContext): RoutedModel {
  // デフォルトは 20B
  let route: RoutedModel = '20b'

  const contextTokens = ctx.contextTokens ?? 0
  const recall = ctx.recall
  const complexity = ctx.complexity
  const safetyTag = ctx.safetyTag ?? 'none'

  const shouldPromoteByContext = contextTokens > 2000
  const shouldPromoteByRecall = recall !== null && recall < RECALL_THRESHOLD
  const shouldPromoteByComplexity =
    complexity !== null && complexity >= COMPLEXITY_THRESHOLD
  const shouldPromoteBySafety =
    safetyTag === 'legal' || safetyTag === 'security' || safetyTag === 'policy'

  if (
    shouldPromoteByContext ||
    shouldPromoteByRecall ||
    shouldPromoteByComplexity ||
    shouldPromoteBySafety
  ) {
    route = '120b'
  }

  return route
}