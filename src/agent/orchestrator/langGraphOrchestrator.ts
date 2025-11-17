// src/agent/orchestrator/langGraphOrchestrator.ts

import { hybridSearch } from '../../search/hybrid'
import { groqClient } from '../llm/groqClient'
import {
	PlannerRoute,
	PlannerRoutingDecision,
	RouteContextV2,
	routePlannerModelV2,
} from '../llm/modelRouter'

/**
 * /agent.dialog の入力ペイロードのサマリ型。
 * 実際には既存のハンドラの型に合わせて拡張してください。
 */
export interface DialogInput {
  tenantId: string
  userMessage: string
  locale: 'ja' | 'en'
  conversationId: string
  /**
   * 直近の会話履歴（圧縮前）。
   */
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  /**
   * 圧縮された過去履歴のサマリ。
   * 長期対話時に古い履歴を要約して保持するために利用する。
   */
  historySummary?: string
}

/**
 * /agent.dialog の最終出力。
 * 実際には root レスポンス型にマージする想定。
 */
export interface DialogOutput {
  text: string
  route: PlannerRoute
  plannerReasons: string[]
  /**
   * Planner が生成したマルチステッププラン。
   * HTTP レイヤーで steps / needsClarification などにマッピングするために公開する。
   */
  plannerPlan?: PlannerPlan
  /**
   * Safety / routing 関連のメタ情報。
   * HTTP レイヤーやログで利用する。
   */
  safetyTag?: string
  requiresSafeMode?: boolean
}

/**
 * Planner が返すステップの型定義。
 */
type PlannerStepBase = {
  id: string
  type: 'clarify' | 'search' | 'tool' | 'answer'
  description?: string
}

export type PlannerClarifyStep = PlannerStepBase & {
  type: 'clarify'
  questions: string[]
}

export type PlannerSearchStep = PlannerStepBase & {
  type: 'search'
  query: string
  topK?: number
  filters?: Record<string, unknown>
}

export type PlannerToolStep = PlannerStepBase & {
  type: 'tool'
  toolName: string
  toolInput?: Record<string, unknown>
}

export type PlannerAnswerStep = PlannerStepBase & {
  type: 'answer'
  style?: 'default' | 'fallback' | 'rich'
}

export type PlannerStep =
  | PlannerClarifyStep
  | PlannerSearchStep
  | PlannerToolStep
  | PlannerAnswerStep

export interface PlannerPlan {
  steps: PlannerStep[]
  needsClarification?: boolean
  clarifyingQuestions?: string[]
  followupQueries?: string[]
  confidence?: 'low' | 'medium' | 'high'
  raw?: unknown
}

/**
 * Graph 内でやり取りする状態。
 * LangGraph 導入時には、この State をそのまま node 間で共有するイメージ。
 */
export interface DialogGraphState {
  input: DialogInput
  /**
   * RAG / context 構築の結果。
   * TODO: 実際の RAG 型に差し替え。
   */
  ragContext?: RagContext
  /**
   * Planner / Answer ルーティングに利用するコンテキスト。
   */
  routeContext: RouteContextV2
  /**
   * Planner の決定結果。
   */
  plannerDecision?: PlannerRoutingDecision
  /**
   * Planner が出した「ステップ」の中間表現。
   */
  plannerSteps?: PlannerPlan
  /**
   * 最終的な応答テキスト。
   */
  finalText?: string
}

/**
 * RAG パイプラインから返されるコンテキストの型。
 *
 * DialogGraphState では optional（?）として扱われるが、
 * runInitialRagRetrieval などから戻る値としては必須。
 */
type RagContext = {
  documents: Array<{ id: string; score: number; text: string }>
  recall: number | null
  contextTokens: number
}

/**
 * 初回の RAG 検索を実行し、DialogGraphState.ragContext 相当の値を返す。
 *
 * Phase3 で実装済みのハイブリッド検索を利用して、RAG コンテキストを構築する。
 */
async function runInitialRagRetrieval(initialInput: DialogInput): Promise<RagContext> {
  // Phase3 で実装済みのハイブリッド検索を利用して、RAG コンテキストを構築する。
  // hybridSearch はクエリ文字列を受け取り、items 配列を含む結果を返す想定。
  const result = await hybridSearch(initialInput.userMessage)

  const documents = (result.items ?? []).map((item: any) => ({
    id: String(item.id),
    score: typeof item.score === 'number' ? item.score : 0,
    text: String(item.text ?? ''),
  }))

  // 簡易的にトークン数を概算（文字数/4）し、上限を設ける。
  const totalChars = documents.reduce((sum, doc) => sum + doc.text.length, 0)
  const contextTokens = Math.min(4096, Math.max(128, Math.floor(totalChars / 4) || 256))

  return {
    documents,
    // Phase3 の hybridSearch には recall 指標がない前提で null とする。
    recall: null,
    contextTokens,
  }
}

/**
 * 長期対話向け: history が一定以上に伸びたら、古いターンを要約して historySummary に格納し、
 * 直近のターンだけを残す。
 */
async function summarizeHistoryIfNeeded(initialInput: DialogInput): Promise<DialogInput> {
  const MAX_HISTORY_MESSAGES = 12 // これを超えたらサマリを作る
  const KEEP_RECENT = 6 // 直近はそのまま保持

  const history = initialInput.history ?? []
  if (history.length <= MAX_HISTORY_MESSAGES) {
    return initialInput
  }

  const older = history.slice(0, history.length - KEEP_RECENT)
  const recent = history.slice(-KEEP_RECENT)

  const summary = await summarizeHistoryWithLLM({
    locale: initialInput.locale,
    older,
    existingSummary: initialInput.historySummary,
  })

  return {
    ...initialInput,
    history: recent,
    historySummary: summary,
  }
}

type ConversationTurn = { role: 'user' | 'assistant'; content: string }

async function summarizeHistoryWithLLM(payload: {
  locale: 'ja' | 'en'
  older: ConversationTurn[]
  existingSummary?: string
}): Promise<string> {
  const { locale, older, existingSummary } = payload

  if (!older.length) {
    return existingSummary ?? ''
  }

  const model = process.env.GROQ_PLANNER_20B_MODEL ?? 'groq/compound-mini'

  const turnsText = older
    .map((m, idx) => `${idx + 1}. ${m.role}: ${m.content}`)
    .join('\n')

  const systemContent =
    locale === 'ja'
      ? 'あなたは会話履歴を要約するアシスタントです。重要な事実・ユーザーの意図・制約条件だけを短くまとめてください。'
      : 'You are an assistant that summarizes conversation history. Capture key facts, user goals, and constraints concisely.'

  const userParts: string[] = []

  if (existingSummary && existingSummary.trim().length > 0) {
    userParts.push(
      locale === 'ja'
        ? `これまでのサマリ:\n${existingSummary}`
        : `Existing summary:\n${existingSummary}`,
    )
  }

  userParts.push(
    locale === 'ja'
      ? `以下の会話ターンを 5〜7 行程度の短いサマリにしてください:\n${turnsText}`
      : `Summarize the following conversation turns into 5–7 short lines:\n${turnsText}`,
  )

  const prompt = userParts.join('\n\n')

  const raw = await groqClient.call({
    model,
    messages: [
      { role: 'system', content: systemContent },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    maxTokens: 384,
  })

  return raw.trim()
}

/**
 * ContextBuilder Node:
 * - RAG 実行
 * - RouteContextV2 の構築
 */
async function contextBuilderNode(initialInput: DialogInput): Promise<DialogGraphState> {
  // Phase4: 初回の RAG 検索を実行し、RouteContextV2 を構築する。
  const ragContext = await runInitialRagRetrieval(initialInput)

  // 会話の深さとコンテキストトークン数から、ざっくり複雑さを推定する。
  const depth = initialInput.history.length
  const tokens = ragContext.contextTokens

  let complexity: 'low' | 'medium' | 'high'
  if (tokens < 512 && depth <= 1) {
    complexity = 'low'
  } else if (tokens > 2048 || depth > 6) {
    complexity = 'high'
  } else {
    complexity = 'medium'
  }

  // DetectIntentHint をルーティング側でも利用しておく
  const intentHint = detectIntentHint(initialInput)

  const requiresSafeMode = detectSafetyFlag(initialInput)
  const routeContext: RouteContextV2 = {
    contextTokens: tokens,
    recall: ragContext.recall,
    complexity,
    safetyTag: requiresSafeMode ? 'sensitive' : 'none',
    conversationDepth: depth,
    used120bCount: 0,
    max120bPerRequest: 1, // とりあえず 1 回まで
    intentType: intentHint,
    ragStats: undefined,
    requiresSafeMode,
  }

  return {
    input: initialInput,
    ragContext,
    routeContext,
  }
}

/**
 * Planner Node:
 * - routePlannerModelV2 で 20B/120B を選択
 * - 選択したモデルで Planner LLM を実行
 * - Phase4 ヒューリスティクスで 20B/120B ルーティングを上書き
 */
async function plannerNode(state: DialogGraphState): Promise<DialogGraphState> {
  // まずは既存の V2 ルーターにルーティングさせる
  const baseDecision = routePlannerModelV2(state.routeContext)

  const ctx = state.routeContext
  let decision = baseDecision

  // Phase4 ヒューリスティクス:
  // - セーフティモードが必要な場合
  // - コンテキストトークンが大きい場合
  // - 会話が深い場合
  // などのときに 120B にエスカレートする。
  if (decision.route === '20b') {
    const extraReasons: string[] = []

    if (ctx.requiresSafeMode) {
      decision = {
        ...decision,
        route: '120b',
        reasons: [...decision.reasons, 'phase4:requires-safe-mode'],
      }
    } else if (ctx.contextTokens > 2048 && ctx.used120bCount < (ctx.max120bPerRequest ?? 1)) {
      decision = {
        ...decision,
        route: '120b',
        reasons: [...decision.reasons, 'phase4:context-tokens-high'],
      }
    } else if (ctx.conversationDepth > 6 && ctx.used120bCount < (ctx.max120bPerRequest ?? 1)) {
      decision = {
        ...decision,
        route: '120b',
        reasons: [...decision.reasons, 'phase4:deep-conversation'],
      }
    } else if (ctx.complexity === 'high' && ctx.used120bCount < (ctx.max120bPerRequest ?? 1)) {
      decision = {
        ...decision,
        route: '120b',
        reasons: [...decision.reasons, 'phase4:complexity-high'],
      }
    }

    // extraReasons 変数は今後拡張用のプレースホルダとして残しておく。
    void extraReasons
  }

  const plannerSteps = await callPlannerLLM(decision.route, {
    input: state.input,
    ragContext: state.ragContext,
  })

  return {
    ...state,
    plannerDecision: decision,
    plannerSteps,
    // V2 ルーティング結果を routeContext に反映しておく
    routeContext: {
      ...state.routeContext,
      used120bCount: decision.used120bCount,
    },
  }
}

/**
 * Decision Router Node:
 * - Planner の出力に応じて Clarify / Search / Answer などの分岐を行う。
 * - v1 実装では Clarify が必要な場合は明示的な確認質問を返し、
 *   それ以外は Answer にフォールバックする。
 */
async function decisionRouterNode(state: DialogGraphState): Promise<DialogGraphState> {
  const plan = state.plannerSteps

  // Safety フラグが立っている場合は、Clarify を挟まずにそのまま Answer へフォールバックする。
  // （暴力・虐待・違法行為などのセンシティブトピックで、誤って「送料」などの Clarify を出さないため）
  if (state.routeContext.requiresSafeMode) {
    return answerNode(state)
  }

  // Planner が Clarify を要求している場合は、
  // いったん Clarifying Questions をそのままユーザーへの出力として返す。
  if (plan && plan.needsClarification && plan.clarifyingQuestions?.length) {
    const clarificationText = plan.clarifyingQuestions.join('\n')

    return {
      ...state,
      finalText: clarificationText,
    }
  }

  // PlannerPlan に search ステップが含まれている場合は、
  // その query を使って RAG 検索をやり直し、検索結果を Answer ノードに渡す。
  const searchStep = plan?.steps.find(
    (s): s is PlannerSearchStep => s.type === 'search',
  )

  if (searchStep) {
    const searchInput: DialogInput = {
      ...state.input,
      userMessage: searchStep.query,
    }

    const ragContext = await runInitialRagRetrieval(searchInput)

    return answerNode({
      ...state,
      ragContext,
    })
  }

  // TODO: 将来的には tool ステップなどにも分岐する。
  // 現時点では Clarify / Search 以外のケースは Answer ノードにフォールバック。
  return answerNode(state)
}

/**
 * Answer Node:
 * - 実際の Answer LLM を呼び出して応答テキストを生成する。
 */
async function answerNode(state: DialogGraphState): Promise<DialogGraphState> {
  const route: PlannerRoute =
    state.plannerDecision?.route ?? '20b' // 念のためデフォルト 20B

  const answerText = await callAnswerLLM(route, {
    input: state.input,
    ragContext: state.ragContext,
    plannerSteps: state.plannerSteps,
    safeMode: state.routeContext.requiresSafeMode,
  })

  return {
    ...state,
    finalText: answerText,
  }
}

/**
 * LangGraph ベースの Dialog Orchestrator エントリポイント。
 *
 * いまは node を直列で呼んでいるだけだが、
 * 後から LangGraph / CrewAI を導入する際には、
 * ここで Graph を構築して実行する形に差し替える。
 */
export async function runDialogGraph(input: DialogInput): Promise<DialogOutput> {
  // 0. 長期対話向けの履歴サマリ圧縮
  const summarizedInput = await summarizeHistoryIfNeeded(input)

  // 1. Context 構築 (RAG + RouteContextV2)
  let state = await contextBuilderNode(summarizedInput)

  // 1.5 シンプルな follow-up などの場合は Planner LLM をスキップして、
  // ルーティングモデルの結果だけを使って直接 Answer に進む fast-path。
  const fastDecision = routePlannerModelV2(state.routeContext)
  if (shouldUseFastAnswer(summarizedInput, state.routeContext)) {
    state = {
      ...state,
      plannerDecision: fastDecision,
    }
    state = await answerNode(state)

    if (!state.finalText) {
      return {
        text: '現在うまくお応えできません。しばらくしてからお試しください。',
        route: fastDecision.route,
        plannerReasons: ['fallback:no-final-text-in-fast-path', ...fastDecision.reasons],
        plannerPlan: state.plannerSteps,
        safetyTag: state.routeContext.safetyTag,
        requiresSafeMode: state.routeContext.requiresSafeMode,
      }
    }

    return {
      text: state.finalText,
      route: fastDecision.route,
      plannerReasons: fastDecision.reasons,
      plannerPlan: state.plannerSteps,
      safetyTag: state.routeContext.safetyTag,
      requiresSafeMode: state.routeContext.requiresSafeMode,
    }
  }

  // 2. Planner 実行（20B/120B ルーティング含む）
  state = await plannerNode(state)

  // 3. Planner 出力に基づいて Clarify/Search/Answer などを実行
  state = await decisionRouterNode(state)

  if (!state.finalText || !state.plannerDecision) {
    // 何かがおかしい場合のフォールバック
    return {
      text: '現在うまくお応えできません。しばらくしてからお試しください。',
      route: '20b',
      plannerReasons: ['fallback:no-final-text-or-decision'],
      plannerPlan: state.plannerSteps,
      safetyTag: state.routeContext.safetyTag,
      requiresSafeMode: state.routeContext.requiresSafeMode,
    }
  }

  return {
    text: state.finalText,
    route: state.plannerDecision.route,
    plannerReasons: state.plannerDecision.reasons,
    plannerPlan: state.plannerSteps,
    safetyTag: state.routeContext.safetyTag,
    requiresSafeMode: state.routeContext.requiresSafeMode,
  }
}
/**
 * シンプルな follow-up （例: Clarify に答えた 2 ターン目など）では、
 * Planner LLM をスキップして Answer だけを実行するためのヒューリスティック。
 *
 * - safety フラグが立っている場合は常に Planner 経由にする
 * - history がまったく無い初回メッセージでは使わない
 * - shipping / returns / payment / product-info などの典型的なコマース系意図で、
 *   現在メッセージが十分に具体的（文字数がある程度長い）な場合に fast-path を有効にする
 */
function shouldUseFastAnswer(input: DialogInput, routeContext: RouteContextV2): boolean {
  if (routeContext.requiresSafeMode) {
    return false
  }

  const depth = input.history?.length ?? 0
  if (depth === 0) {
    return false
  }

  const text = (input.userMessage || '').toLowerCase()
  if (text.length < 15) {
    return false
  }

  const intent = detectIntentHint(input)
  const fastIntents = ['shipping', 'returns', 'payment', 'product-info']

  return fastIntents.includes(intent)
}

/**
 * 簡易的なセーフティフラグ検出ヘルパー。
 * 本番環境では専用の safety classifier に置き換える想定。
 */
function detectSafetyFlag(input: DialogInput): boolean {
  const text =
    [
      input.userMessage,
      ...(input.history ?? []).map((m) => m.content),
    ]
      .join(' ')
      .toLowerCase()

  const safetyKeywords = [
    // self-harm / suicide (日本語・英語の一部)
    '自殺',
    '死にたい',
    'リストカット',
    '自傷',
    '自殺したい',
    'suicide',
    'kill myself',
    // violence / abuse
    '暴力',
    '虐待',
    'dv',
    '暴行',
    'assault',
    'abuse',
    // illegal activity (ごく一部の一般的なキーワード)
    '違法',
    '犯罪',
    'drug',
    'drugs',
  ]

  return safetyKeywords.some((k) => text.includes(k.toLowerCase()))
}

/**
 * Intent ヒント検出ヘルパー
 */
function detectIntentHint(input: DialogInput): string {
  const text =
    [
      input.userMessage,
      ...(input.history ?? []).map((m) => m.content),
    ]
      .join(' ')
      .toLowerCase()

  // shipping / delivery
  const shippingKeywords = [
    '送料',
    '配送料',
    '配送',
    'お届け',
    '届く',
    '到着',
    '何日',
    'when will it arrive',
    'delivery',
    'shipping',
  ]
  if (shippingKeywords.some((k) => text.includes(k.toLowerCase()))) {
    return 'shipping'
  }

  // returns / refunds / cancellations
  const returnKeywords = [
    '返品',
    '返金',
    'キャンセル',
    '交換',
    '不良品',
    'return',
    'refund',
    'cancel',
  ]
  if (returnKeywords.some((k) => text.includes(k.toLowerCase()))) {
    return 'returns'
  }

  // payment / billing
  const paymentKeywords = [
    '支払',
    '支払い',
    '決済',
    'クレジット',
    'カード',
    '請求',
    '領収書',
    'invoice',
    'payment',
    'pay',
  ]
  if (paymentKeywords.some((k) => text.includes(k.toLowerCase()))) {
    return 'payment'
  }

  // product information
  const productKeywords = [
    '在庫',
    '入荷',
    'サイズ',
    '色',
    'カラー',
    '素材',
    '仕様',
    '詳細',
    'stock',
    'size',
    'color',
    'material',
  ]
  if (productKeywords.some((k) => text.includes(k.toLowerCase()))) {
    return 'product-info'
  }

  return 'general'
}

/**
 * Planner 用のプロンプトを組み立てるヘルパ。
 * 実際のプロンプト設計は Phase3 の仕様に合わせてチューニングしてください。
 */
function buildPlannerPrompt(payload: {
  input: DialogInput
  ragContext?: DialogGraphState['ragContext']
}): string {
  const { input } = payload

  const recentLines =
    input.history && input.history.length
      ? input.history
          .slice(-6)
          .map((m, idx) => `${idx + 1}. ${m.role}: ${m.content}`)
          .join('\n')
      : '(no recent messages)'

  const intent = detectIntentHint(input)

  const summaryBlock = input.historySummary
    ? [
        'Summarized earlier conversation (compressed):',
        input.historySummary,
        '',
        'Recent conversation history (most recent last):',
      ].join('\n')
    : 'Recent conversation history (most recent last):'

  return [
    'You are the dialog planner for a commerce FAQ assistant.',
    `User locale: ${input.locale}`,
    `Detected intent (rough guess): ${intent}`,
    '',
    summaryBlock,
    recentLines,
    '',
    `Current user message: "${input.userMessage}"`,
    '',
    'Output STRICTLY a single JSON object with the following shape:',
    '',
    '{',
    '  "steps": [',
    '    {',
    '      "id": "step_clarify_1",',
    '      "type": "clarify",',
    '      "description": "clarify the ambiguous question",',
    '      "questions": ["どの商品についての質問ですか？", "お届け先の地域はどちらですか？"]',
    '    },',
    '    {',
    '      "id": "step_search_1",',
    '      "type": "search",',
    '      "description": "search FAQ articles",',
    '      "query": "送料はいくらですか",',
    '      "topK": 8,',
    '      "filters": { "category": "shipping", "categories": ["shipping", "payment"] }',
    '    },',
    '    {',
    '      "id": "step_answer_1",',
    '      "type": "answer",',
    '      "description": "answer with general policy",',
    '      "style": "fallback"',
    '    }',
    '  ],',
    '  "needsClarification": true,',
    '  "clarifyingQuestions": ["どの商品・どの地域への配送／送料について知りたいですか？"],',
    '  "followupQueries": [],',
    '  "confidence": "medium"',
    '}',
    '',
    'Rules:',
    '- Respond with JSON ONLY. No prose, no explanation.',
    '- Choose step.type only from: "clarify", "search", "tool", "answer".',
    '- If the current user message clearly answers a previous clarification question',
    '  (for example, the assistant previously asked about product and region, and the user now provides those details),',
    '  then DO NOT add any new clarify steps, and set "needsClarification" to false.',
    '- In that case, start the steps directly from "search" and/or "answer".',
    '- For ambiguous shipping questions with insufficient detail, prefer a clarify step first, then search, then answer.',
    '- When the detected intent is "returns", prefer clarification questions about order ID, purchase date, item condition, and reason for return.',
    '- When the detected intent is "payment", prefer clarification questions about payment method, error messages, and whether the charge was completed.',
    '- When the detected intent is "product-info", prefer clarification questions about size, color, stock availability, or specific product variants.',
  ].join('\n')
}

/**
 * Answer 用のプロンプトを組み立てるヘルパ。
 */
function buildAnswerPrompt(payload: {
  input: DialogInput
  ragContext?: DialogGraphState['ragContext']
  plannerSteps?: unknown
  safeMode?: boolean
}): string {
  const { input, ragContext, safeMode } = payload

  const docs = ragContext?.documents ?? []
  const contextSnippet =
    docs.length > 0
      ? docs
          .slice(0, 3)
          .map((d, idx) => `${idx + 1}. ${d.text}`)
          .join('\n')
      : '(no retrieved documents)'

  const baseLines = [
    input.historySummary
      ? `Summarized prior conversation: ${input.historySummary}`
      : undefined,
    `User message: ${input.userMessage}`,
    '',
    'Context documents (top snippets):',
    contextSnippet,
    '',
  ].filter((v): v is string => Boolean(v))

  const normalInstructions = [
    'Use the above context and any previously executed tools or steps to answer the user.',
    'Keep the answer reasonably concise (around 3–8 short sentences or bullet points).',
    'Avoid large tables or very long paragraphs unless the user explicitly requested them.',
    'If you are not sure, clearly say that you are not sure.',
  ]

  const safeModeInstructions = [
    'The topic may involve sensitive, harmful, or abusive content.',
    'Respond in a cautious, supportive, and neutral tone.',
    'Keep the answer concise (around 3–6 short bullet points or paragraphs).',
    'Do NOT provide explicit instructions that could enable self-harm, violence, abuse, or illegal activities.',
    'Explicitly mention that this is general information and may not fully apply to the user’s specific situation.',
    'If the user appears to be in danger or asking for how to commit harm, politely refuse and instead encourage seeking help from appropriate professionals or authorities.',
    'If you are not sure, clearly say that you are not sure, and avoid speculation.',
  ]

  const instructions = safeMode ? safeModeInstructions : normalInstructions

  return [...baseLines, ...instructions].join('\n')
}

/**
 * 実際の Planner LLM 呼び出し。
 * - Groq GPT-OSS 20B/120B を呼ぶ実装をここに隠蔽する。
 */
async function callPlannerLLM(
  route: PlannerRoute,
  payload: {
    input: DialogInput
    ragContext?: DialogGraphState['ragContext']
  }
): Promise<PlannerPlan> {
  const model =
    route === '120b'
      ? process.env.GROQ_PLANNER_120B_MODEL ?? 'groq/compound'
      : process.env.GROQ_PLANNER_20B_MODEL ?? 'groq/compound-mini'

  const prompt = buildPlannerPrompt(payload)

  const raw = await groqClient.call({
    model,
    messages: [
      {
        role: 'system',
        content:
          'You are the dialog planner for a commerce FAQ assistant. Always respond with valid JSON only.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    temperature: 0,
    maxTokens: 512,
  })

  try {
    const parsed = JSON.parse(raw) as PlannerPlan

    if (!parsed || !Array.isArray(parsed.steps)) {
      throw new Error('Planner JSON has no steps array')
    }

    return parsed
  } catch {
    return {
      steps: [
        {
          id: 'fallback_answer_1',
          type: 'answer',
          description: 'fallback answer step due to planner JSON parse error',
          style: 'fallback',
        },
      ],
      confidence: 'low',
      raw,
    }
  }
}

/**
 * 実際の Answer LLM 呼び出し。
 * - Groq GPT-OSS 20B/120B を呼ぶ実装をここに隠蔽する。
 */
async function callAnswerLLM(
  route: PlannerRoute,
  payload: {
    input: DialogInput
    ragContext?: DialogGraphState['ragContext']
    plannerSteps?: unknown
    safeMode?: boolean
  }
): Promise<string> {
  const model =
    route === '120b'
      ? process.env.GROQ_ANSWER_120B_MODEL ?? 'groq/compound'
      : process.env.GROQ_ANSWER_20B_MODEL ?? 'groq/compound-mini'

  const prompt = buildAnswerPrompt(payload)

  const maxTokens = payload.safeMode ? 320 : 256

  const raw = await groqClient.call({
    model,
    messages: [
      {
        role: 'system',
        content:
          'You are a commerce FAQ assistant. Answer clearly, in the user locale, and strictly follow any tool / RAG evidence.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    temperature: 0.2,
    maxTokens,
  })

  return raw
}