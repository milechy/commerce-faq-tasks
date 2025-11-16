

// src/agent/llm/modelRouter.ts

/**
 * LLM ルーティング用コンテキスト。
 *
 * REQUIREMENTS.md / ARCHITECTURE.md の要件に沿って、
 * - 既定: 20B
 * - 昇格条件:
 *   - contextTokens > 2000
 *   - recall < 0.6
 *   - complexity === 'high'
 *   - safetyTag が legal/security/policy のいずれか
 * - フォールバック戦略や 120B 比率 (≤10%) の制御は、
 *   実際の LLM 呼び出し側（メトリクス/制御層）で行う前提とする。
 */
export interface RouteContext {
  /**
   * プロンプト + コンテキストの推定トークン数。
   */
  contextTokens: number

  /**
   * RAG の recall 指標（0〜1）。null の場合は未評価とみなす。
   */
  recall: number | null

  /**
   * 質問の複雑度スコア（簡易カテゴリ）。
   */
  complexity: 'low' | 'medium' | 'high' | null

  /**
   * セーフティ関連のタグ。legal/security/policy 等。
   */
  safetyTag: 'none' | 'legal' | 'security' | 'policy' | string
}

export type PlannerRoute = '20b' | '120b'

/**
 * GPT-OSS 20B/120B 用のルーティング関数。
 *
 * - まず環境変数 `LLM_FORCE_PLANNER_ROUTE` があればそれを最優先で使用（デバッグ用）。
 * - それ以外は RouteContext に基づくシンプルな rule-based 判定を行う。
 */
export function routePlannerModel(ctx: RouteContext): PlannerRoute {
  const force = process.env.LLM_FORCE_PLANNER_ROUTE
  if (force === '20b' || force === '120b') {
    return force
  }

  const { contextTokens, recall, complexity, safetyTag } = ctx

  // 1) セーフティタグ優先（legal/security/policy は常に 120B）
  if (safetyTag === 'legal' || safetyTag === 'security' || safetyTag === 'policy') {
    return '120b'
  }

  // 2) トークン数が多い場合は 120B
  if (contextTokens > 2000) {
    return '120b'
  }

  // 3) RAG recall が低い場合は 120B で再検討
  if (typeof recall === 'number' && recall < 0.6) {
    return '120b'
  }

  // 4) 複雑度が high の場合は 120B
  if (complexity === 'high') {
    return '120b'
  }

  // それ以外は 20B
  return '20b'
}