// src/agent/dialog/types.ts

import type { AgentStep } from '../types'
import type { OrchestratorStep } from '../flow/dialogOrchestrator'

export type PlanStepType =
  | 'clarify'
  | 'search'
  | 'followup_search'
  | 'answer'

export interface BasePlanStep {
  id: string
  type: PlanStepType
  description?: string
}

export interface ClarifyStep extends BasePlanStep {
  type: 'clarify'
  /**
   * ユーザーに投げる Clarifying Question。
   * 複数ある場合は順番に確認していく。
   */
  questions: string[]
}

export interface SearchStep extends BasePlanStep {
  type: 'search'
  /**
   * 実際に検索ツールに投げる query
   */
  query: string
  /**
   * Hybrid Search / Rerank 用の topK
   */
  topK: number
  /**
   * 将来のフィルタ（カテゴリや必須キーワードなど）
   */
  filters?: Record<string, unknown> | null;
}

export interface FollowupSearchStep extends BasePlanStep {
  type: 'followup_search'
  /**
   * どの情報をベースに follow-up を生成したか
   */
  basedOn: 'user' | 'previous_answer'
  query: string
  topK: number
}

export interface AnswerStep extends BasePlanStep {
  type: 'answer'
  style: 'faq' | 'step_by_step'
  includeSources: boolean
}

export type PlanStep =
  | ClarifyStep
  | SearchStep
  | FollowupSearchStep
  | AnswerStep

export interface MultiStepQueryPlan {
  steps: PlanStep[]

  /**
   * ClarifyStep が必要かどうか。
   * steps 内に ClarifyStep が含まれている場合は true になる。
   */
  needsClarification: boolean

  /**
   * ユーザーに提示すべき Clarifying Question の一覧。
   * steps 内の ClarifyStep からまとめたもの。
   */
  clarifyingQuestions?: string[]

  /**
   * 追撃検索に使う候補クエリ。
   */
  followupQueries?: string[]

  /**
   * プラン全体の信頼度。
   */
  confidence: 'low' | 'medium' | 'high'

  /**
   * 入力クエリの主要言語（Planner が推定）。
   */
  language?: 'ja' | 'en' | 'other'

  /**
   * LLM プランナーなどの生レスポンスをそのまま保持するためのフィールド。
   */
  raw?: unknown
}

export type DialogMessageRole = 'user' | 'assistant' | 'system'

export interface DialogMessage {
  role: DialogMessageRole
  content: string
}

/**
 * /agent.dialog に相当する 1 ターン分の入力
 */
export interface DialogTurnInput {
  sessionId?: string
  /**
   * 今回のユーザーメッセージ
   */
  message: string
  /**
   * 必要に応じてクライアント / サーバ側で保持している履歴を含める。
   * MVP では必須ではない。
   */
  history?: DialogMessage[]
  options?: {
    topK?: number
    language?: 'ja' | 'en' | 'auto'
    useLlmPlanner?: boolean
    useMultiStepPlanner?: boolean
    /**
     * Orchestrator のモード。
     * - 'local': Node.js 内で完結
     * - 'crew': 外部 CrewAI Orchestrator に委譲（将来）
     */
    mode?: 'local' | 'crew'
    debug?: boolean
  }
}

export interface DialogTurnMeta {
  multiStepPlan?: MultiStepQueryPlan
  orchestratorMode: 'local' | 'crew'
  latencyMs?: number
  needsClarification?: boolean
  clarifyingQuestions?: string[]
  orchestrationSteps?: OrchestratorStep[]
}

/**
 * /agent.dialog からクライアントに返す 1 ターン分の結果
 */
export interface DialogTurnResult {
  sessionId: string
  /**
   * Clarifying Question のターンなどでは null のこともある。
   */
  answer: string | null
  needsClarification: boolean
  clarifyingQuestions?: string[]

  /**
   * Agent の内部ステップログ。
   * 既存の AgentStep を再利用する。
   */
  steps: (AgentStep | OrchestratorStep)[]

  /**
   * このターンで FAQ の回答が完結しているかどうか。
   * false の場合、クライアント側は追加のユーザー入力を促すことができる。
   */
  final: boolean

  meta?: DialogTurnMeta
}