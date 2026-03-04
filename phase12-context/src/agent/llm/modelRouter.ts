

// src/agent/llm/modelRouter.ts

/**
 * LLM ルーティング用コンテキスト（基本版）。
 *
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
  contextTokens: number
  recall: number | null
  complexity: 'low' | 'medium' | 'high' | null
  safetyTag: 'none' | 'legal' | 'security' | 'policy' | string
}

/**
 * LLM ルーティング用コンテキスト（拡張版）。
 *
 * REQUIREMENTS.md / ARCHITECTURE.md の要件に沿って、
 * RouteContext をベースに、
 * - 会話深度
 * - 120B 使用回数 / 上限
 * - 意図カテゴリ
 * - RAG スコア統計
 * - セーフティモードフラグ
 * などを追加で保持する。
 */
export interface RouteContextV2 extends RouteContext {
  /**
   * 現在の会話深度（turn 数）。
   * 長期対話コンテキストの圧縮判断などに利用。
   */
  conversationDepth: number

  /**
   * このリクエスト内で、すでに 120B を使用した回数。
   * 120B 比率 ≤ 10% を守るためのガードに利用。
   */
  used120bCount: number

  /**
   * このリクエスト内で許容される 120B 呼び出しの最大回数。
   * 例: 1 リクエストあたり最大 1 回など。
   */
  max120bPerRequest: number

  /**
   * ユーザ意図カテゴリ（簡易）。
   * 例: 'faq', 'product', 'order', 'return', 'legal', 'security' など。
   */
  intentType: string | null

  /**
   * RAG で取得したドキュメントのスコア統計。
   * recall よりも細かい分布を見るために利用可能。
   */
  ragStats?: {
    topScore: number | null
    secondScore: number | null
    scoreGap: number | null
    avgTopKScore: number | null
  }

  /**
   * セーフティ/ポリシー的に慎重モードが必要かどうか。
   * 外部の safety classifier の結果を想定。
   */
  requiresSafeMode?: boolean
}

/**
 * V2 ルーティングの決定結果。
 *
 * - route: 実際に選択されたモデル（20b/120b）
 * - reasons: 判定理由のリスト（ログ・デバッグ用）
 * - used120bCount: 判定後の 120B 使用回数（呼び出し側でインクリメントしてもよい）
 */
export interface PlannerRoutingDecision {
  route: PlannerRoute
  reasons: string[]
  used120bCount: number
}

/**
 * Phase4 用の拡張ルーティング関数。
 *
 * - 既存の routePlannerModel(ctx: RouteContext) を内包しつつ、
 *   120B 使用上限や追加コンテキストを考慮した判定を行う。
 * - 実際の 120B 比率制御（全体で ≤10%）はメトリクス層で行う前提だが、
 *   1 リクエスト内での乱用はここでガードする。
 */
export function routePlannerModelV2(ctx: RouteContextV2): PlannerRoutingDecision {
  const force = process.env.LLM_FORCE_PLANNER_ROUTE
  const reasons: string[] = []

  // デバッグ用の強制ルート
  if (force === '20b' || force === '120b') {
    reasons.push(`forced-by-env:${force}`)
    return {
      route: force,
      reasons,
      used120bCount: force === '120b' ? ctx.used120bCount + 1 : ctx.used120bCount,
    }
  }

  // 1) 120B 使用上限チェック（リクエスト内）
  if (ctx.used120bCount >= ctx.max120bPerRequest) {
    reasons.push(
      `limit-120b-per-request:used=${ctx.used120bCount},max=${ctx.max120bPerRequest}`
    )
    // 上限超過時は 20B にフォールバック
    return {
      route: '20b',
      reasons,
      used120bCount: ctx.used120bCount,
    }
  }

  // 2) 既存のシンプルルールをベースに route 候補を決定
  const baseRoute = routePlannerModel(ctx)

  if (baseRoute === '120b') {
    reasons.push('base-rule:120b')
  } else {
    reasons.push('base-rule:20b')
  }

  // 3) セーフティ/慎重モード（requiresSafeMode が true の場合は優先して 120B）
  if (ctx.requiresSafeMode && baseRoute === '20b') {
    reasons.push('safe-mode:upgrade-to-120b')
    // 上限チェックはすでに済んでいるので、そのまま 120B に昇格
    return {
      route: '120b',
      reasons,
      used120bCount: ctx.used120bCount + 1,
    }
  }

  // 4) 意図カテゴリや会話深度に基づく微調整（必要に応じてルール追加）
  // 例: 法務系で intentType が 'legal' なら 120B を優先
  if (ctx.intentType === 'legal' && baseRoute === '20b') {
    reasons.push('intent:legal-upgrade-to-120b')
    return {
      route: '120b',
      reasons,
      used120bCount: ctx.used120bCount + 1,
    }
  }

  // 例: 会話深度が浅く、かつ RAG スコアが十分に高い場合は 20B で十分とみなす
  if (
    baseRoute === '120b' &&
    ctx.conversationDepth <= 2 &&
    typeof ctx.recall === 'number' &&
    ctx.recall >= 0.8
  ) {
    reasons.push('downgrade-to-20b:short-conversation-and-good-recall')
    return {
      route: '20b',
      reasons,
      used120bCount: ctx.used120bCount,
    }
  }

  // 5) デフォルト: baseRoute をそのまま採用
  return {
    route: baseRoute,
    reasons,
    used120bCount: baseRoute === '120b' ? ctx.used120bCount + 1 : ctx.used120bCount,
  }
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