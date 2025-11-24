// src/agent/flow/llmMultiStepPlannerRuntime.ts

import { routePlannerModel, type RouteContext } from '../../llm/modelRouter'
import type { DialogMessage, MultiStepQueryPlan } from '../dialog/types'
import type { MultiStepPlannerOptions } from './multiStepPlanner'
import { planMultiStepQuery as planMultiStepQueryRuleBased } from './multiStepPlanner'

export interface LlmMultiStepPlannerOptions extends MultiStepPlannerOptions {
  /**
   * LLM 用ルーティングコンテキスト。
   * Phase3 では一部フィールドは未使用でもよいが、I/F は要件通りに揃えておく。
   */
  routeContext?: Partial<RouteContext>

  /**
   * モデル名を直接指定したい場合に使用。
   * 通常は routing + 環境変数で決定するため未指定でよい。
   */
  overrideModel?: string
}

/**
 * LLM から返ってくる Multi-Step Plan の JSON 形状。
 */
interface LlmPlanStepBase {
  id: string
  type: 'clarify' | 'search' | 'followup_search' | 'answer'
  description?: string
}

interface LlmClarifyStep extends LlmPlanStepBase {
  type: 'clarify'
  questions: string[]
}

interface LlmSearchStep extends LlmPlanStepBase {
  type: 'search'
  query: string
  topK?: number
  filters?: Record<string, unknown> | null
}

interface LlmFollowupSearchStep extends LlmPlanStepBase {
  type: 'followup_search'
  basedOn: 'user' | 'previous_answer'
  query: string
  topK?: number
}

interface LlmAnswerStep extends LlmPlanStepBase {
  type: 'answer'
  style?: 'faq' | 'step_by_step'
  includeSources?: boolean
}

type LlmPlanStep =
  | LlmClarifyStep
  | LlmSearchStep
  | LlmFollowupSearchStep
  | LlmAnswerStep

interface LlmMultiStepPlan {
  steps: LlmPlanStep[]
  needsClarification: boolean
  clarifyingQuestions?: string[]
  followupQueries?: string[]
  confidence: 'low' | 'medium' | 'high'
  language?: 'ja' | 'en' | 'other'
}

/**
 * 履歴 → プレーンテキスト
 */
function buildHistoryText(history?: DialogMessage[]): string {
  if (!history || history.length === 0) return ''
  return history.map((m) => `${m.role}: ${m.content}`).join('\n')
}

/**
 * Groq / GPT-OSS 20B/120B 用のプロンプト組み立て。
 * docs/PHASE3_MULTISTEP.md 3.4 に対応。
 */
function buildPlannerPrompts(input: string, history?: DialogMessage[]): {
  system: string
  user: string
} {
  const system = [
    'あなたは EC / コマース FAQ 検索の「プランナー」です。',
    'ユーザーの質問と会話履歴をもとに、',
    'Clarify / Search / Followup / Answer のステップを含む Multi-Step Plan を JSON で出力します。',
    '',
    '制約:',
    '- 出力は必ず JSON オブジェクトのみ。余計な文章やコードブロックマーカーは禁止。',
    '- スキーマ: { steps: [...], needsClarification, clarifyingQuestions?, followupQueries?, confidence, language? } に従うこと。',
    '- 曖昧な質問 → ClarifyStep を生成し needsClarification を true にする。',
    '- 会話履歴がある場合、明らかにフォローアップなら followup_search を使う。',
    '- answer ステップは FAQ の最終回答生成を表すステップ。',
    '- language はユーザー入力の主要言語を推定して設定する。',
    '',
    '各ステップの id は "step_search_1" のように一意の文字列とする。',
  ].join('\n')

  const historyText = buildHistoryText(history)

  const userLines = [
    '以下はユーザーの最新の質問と、必要に応じて直近の会話履歴です。',
    'FAQ 検索エージェントの実行プランを JSON で生成してください。',
    '',
    '## 現在のユーザー質問',
    input,
  ]

  if (historyText) {
    userLines.push('', '## 会話履歴（古い順）', historyText)
  }

  return { system, user: userLines.join('\n') }
}

/**
 * ルーティング用コンテキストを組み立てる。
 * Phase3 v1 では多くが未使用でもよいが、I/F を揃えておく。
 */
function buildRouteContext(
  options: LlmMultiStepPlannerOptions,
): RouteContext {
  const partial = options.routeContext ?? {}

  return {
    contextTokens: partial.contextTokens ?? 0,
    recall: partial.recall ?? null,
    complexity: partial.complexity ?? null,
    safetyTag: partial.safetyTag ?? 'none',
  }
}

/**
 * Groq (OpenAI 互換) API を叩いて LLM プランを取得。
 *
 * - 既定: 20B モデル
 * - 昇格: routePlannerModel の結果が "120b" の場合は 120B モデルを使用
 * - フォールバック: 20B 呼び出し失敗時に 120B を 1 回だけ試す
 */
async function fetchLlmPlan(
  input: string,
  options: LlmMultiStepPlannerOptions,
  history?: DialogMessage[],
): Promise<{ plan: LlmMultiStepPlan | null; route: '20b' | '120b'; usedModel: string | null }> {
  const apiKey = process.env.LLM_API_KEY
  if (!apiKey) {
    return { plan: null, route: '20b', usedModel: null }
  }

  const baseUrl =
    process.env.LLM_API_BASE ?? 'https://api.groq.com/openai/v1'
  const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`

  const model20b =
    process.env.LLM_MODEL_20B ?? 'openai/gpt-oss-20b'
  const model120b =
    process.env.LLM_MODEL_120B ?? 'openai/gpt-oss-120b'

  const routeCtx = buildRouteContext(options)
  const routed = routePlannerModel(routeCtx)

  const primaryModel =
    options.overrideModel ??
    (routed === '20b' ? model20b : model120b)

  const { system, user } = buildPlannerPrompts(input, history)

  async function callModel(model: string): Promise<LlmMultiStepPlan | null> {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      })

      if (!res.ok) {
        return null
      }

      const data: any = await res.json()
      const content = data?.choices?.[0]?.message?.content
      if (!content || typeof content !== 'string') return null

      const parsed = JSON.parse(content) as LlmMultiStepPlan
      if (!parsed || !Array.isArray(parsed.steps)) return null

      return parsed
    } catch {
      return null
    }
  }

  // まずはルーティング結果に従って呼び出し
  const primaryPlan = await callModel(primaryModel)
  if (primaryPlan) {
    return { plan: primaryPlan, route: routed, usedModel: primaryModel }
  }

  // 20B の失敗時のみ 120B へ 1 回だけフォールバック
  if (routed === '20b' && model120b && model120b !== primaryModel) {
    const fallbackPlan = await callModel(model120b)
    if (fallbackPlan) {
      return { plan: fallbackPlan, route: '120b', usedModel: model120b }
    }
  }

  return { plan: null, route: routed, usedModel: primaryModel }
}

/**
 * Rule-based プランに LLM（Groq GPT-OSS 20B/120B）のメタ情報をマージ。
 */
function mergeLlmPlanIntoMultiStepPlan(
  base: MultiStepQueryPlan,
  llmPlan: LlmMultiStepPlan,
  route: '20b' | '120b',
  usedModel: string | null,
): MultiStepQueryPlan {
  return {
    ...base,
    needsClarification:
      typeof llmPlan.needsClarification === 'boolean'
        ? llmPlan.needsClarification
        : base.needsClarification,
    clarifyingQuestions:
      llmPlan.clarifyingQuestions?.length
        ? llmPlan.clarifyingQuestions
        : base.clarifyingQuestions,
    followupQueries:
      llmPlan.followupQueries?.length
        ? llmPlan.followupQueries
        : base.followupQueries,
    confidence: llmPlan.confidence ?? base.confidence,
    language: llmPlan.language ?? base.language,
    raw: {
      ...(base.raw ?? {}),
      llmPlan,
      llmRoute: {
        route,
        model: usedModel,
      },
    },
  }
}

/**
 * LLM ベース Multi-Step Planner エントリポイント（Groq GPT-OSS 20B/120B）。
 *
 * - まず Rule-based プランを生成
 * - その後 LLM JSON プランが取れればメタ情報を上書き
 * - LLM 呼び出しが失敗しても /agent.dialog の安定性は維持（Rule-based のみ）
 */
export async function planMultiStepQueryWithLlmAsync(
  input: string,
  options: LlmMultiStepPlannerOptions = {},
  history?: DialogMessage[],
): Promise<MultiStepQueryPlan> {
  const basePlan = await planMultiStepQueryRuleBased(input, options, history)

  const { plan: llmPlan, route, usedModel } = await fetchLlmPlan(
    input,
    options,
    history,
  )

  if (!llmPlan) {
    return basePlan
  }

  return mergeLlmPlanIntoMultiStepPlan(basePlan, llmPlan, route, usedModel)
}