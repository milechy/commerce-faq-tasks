// src/agent/dialog/dialogAgent.ts

import crypto from 'node:crypto'
import { runDialogOrchestrator } from '../flow/dialogOrchestrator'
import { planMultiStepQueryWithLlmAsync } from '../flow/llmMultiStepPlannerRuntime'
import { planMultiStepQuery } from '../flow/multiStepPlanner'
import { appendToSessionHistory, getSessionHistory } from './contextStore'
import type { DialogMessage, DialogTurnInput, DialogTurnResult } from './types'
import { runSalesOrchestrator } from '../orchestrator/sales/salesOrchestrator'
import { getSalesSessionMeta, setSalesSessionMeta } from './salesContextStore'
import type { ProposeIntent } from '../orchestrator/sales/proposePromptBuilder'
import type { RecommendIntent } from '../orchestrator/sales/recommendPromptBuilder'
import type { CloseIntent } from '../orchestrator/sales/closePromptBuilder'
import { detectSalesIntents } from '../orchestrator/sales/salesIntentDetector'
import { getSalesTemplate } from '../orchestrator/sales/salesRules'
import {
  globalSalesLogWriter,
  type SalesLogPhase,
} from '../../integration/notion/salesLogWriter'

// ユーザー入力 + 会話履歴からざっくりトークン数を見積もる。
// （Phase3 v1 では char/4 の雑な近似で十分）
function estimateContextTokens(
  input: string,
  history?: DialogMessage[],
): number {
  const historyText =
    history?.map((m) => m.content ?? '').join('\n') ?? ''
  const totalChars = input.length + historyText.length

  const approxTokens = Math.max(1, Math.round(totalChars / 4))
  return approxTokens
}

function ensureSessionId(sessionId?: string): string {
  if (sessionId && sessionId.length > 0) return sessionId
  return crypto.randomUUID()
}

const DEFAULT_PROPOSE_INTENT: ProposeIntent = 'trial_lesson_offer'
const DEFAULT_RECOMMEND_INTENT: RecommendIntent = 'recommend_course_based_on_level'
const DEFAULT_CLOSE_INTENT: CloseIntent = 'close_next_step_confirmation'

const DEFAULT_PERSONA_TAGS: string[] = ['beginner']
const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID ?? 'english-demo'

export async function runDialogTurn(
  input: DialogTurnInput,
): Promise<DialogTurnResult> {
  const { message, sessionId, options } = input

  const effectiveSessionId = ensureSessionId(sessionId)

  // 既存セッション履歴を取得
  const history = getSessionHistory(effectiveSessionId)

  // 1) Multi-Step Planner
  const useMultiStepPlanner = options?.useMultiStepPlanner ?? true
  const useLlmPlanner = options?.useLlmPlanner === true

  const contextTokens = estimateContextTokens(message, history)

  const basePlannerOptions = {
    topK: options?.topK,
    language: options?.language,
  }

  let multiStepPlan

  if (useMultiStepPlanner) {
    multiStepPlan = useLlmPlanner
      ? await planMultiStepQueryWithLlmAsync(
          message,
          {
            ...basePlannerOptions,
            routeContext: {
              contextTokens,
              recall: null,
              complexity: null,
              safetyTag: 'none',
            },
          },
          history,
        )
      : await planMultiStepQuery(message, basePlannerOptions, history)
  } else {
    // Phase3 v1 では useMultiStepPlanner=false でも内部的には同じ Planner を利用する
    multiStepPlan = await planMultiStepQuery(message, basePlannerOptions, history)
  }

  // 1.5) SalesOrchestrator: SalesFlow (Propose など) を評価
  const previousSalesMeta = getSalesSessionMeta(effectiveSessionId)

  const personaTags =
    options?.personaTags && options.personaTags.length > 0
      ? options.personaTags
      : DEFAULT_PERSONA_TAGS

  // Phase14+: SalesFlow 用の intent を簡易ルールベースで自動検出
  const detectedIntents = detectSalesIntents({
    userMessage: message,
    history: history ?? [],
    plan: multiStepPlan,
  })

  const proposeIntent =
    detectedIntents.proposeIntent ?? DEFAULT_PROPOSE_INTENT
  const recommendIntent =
    detectedIntents.recommendIntent ?? DEFAULT_RECOMMEND_INTENT
  const closeIntent =
    detectedIntents.closeIntent ?? DEFAULT_CLOSE_INTENT

  const salesResult = runSalesOrchestrator({
    detection: {
      userMessage: message,
      history: history ?? [],
      plan: multiStepPlan,
    },
    previousMeta: previousSalesMeta,
    proposeIntent,
    recommendIntent,
    closeIntent,
    personaTags,
  })

  // セッションに SalesMeta を保存（次ターンの previousMeta 用）
  setSalesSessionMeta(effectiveSessionId, salesResult.meta)

  // 2) Orchestrator に実行を委譲
  const orchestrated = await runDialogOrchestrator({
    plan: multiStepPlan,
    sessionId: effectiveSessionId,
    history: history ?? [],
    options: {
      topK: options?.topK,
      debug: options?.debug,
    },
  })

  // SalesOrchestrator の結果に応じて、必要なら Sales 用の回答に差し替える
  if (salesResult.nextStage && salesResult.prompt) {
    orchestrated.answer = salesResult.prompt
    orchestrated.final = true
    orchestrated.needsClarification = false
    orchestrated.clarifyingQuestions = undefined
  }

  // SalesLogWriter に SalesFlow の出力を記録（Notion / DB 用）
  if (salesResult.nextStage && salesResult.prompt && globalSalesLogWriter) {
    const phase = salesResult.nextStage as SalesLogPhase

    let intentSlug: string
    switch (phase) {
      case 'propose':
        intentSlug = proposeIntent
        break
      case 'recommend':
        intentSlug = recommendIntent
        break
      case 'close':
        intentSlug = closeIntent
        break
      default:
        intentSlug = DEFAULT_PROPOSE_INTENT
        break
    }

    // Notion テンプレの有無を確認し、templateSource を notion / fallback で判定
    const tmplForLog = getSalesTemplate({
      phase: phase as any,
      intent: intentSlug,
      personaTags,
    }) as any

    const templateSource = tmplForLog?.template ? 'notion' : 'fallback'
    const templateId = tmplForLog?.id ?? undefined

    await globalSalesLogWriter.write({
      tenantId: DEFAULT_TENANT_ID,
      sessionId: effectiveSessionId,
      phase,
      intent: intentSlug,
      personaTags,
      userMessage: message,
      templateSource,
      templateId,
      templateText: salesResult.prompt,
    })
  }

  // 3) セッション履歴を更新（user 発話 + assistant 回答）
  const updates: DialogMessage[] = [
    { role: 'user', content: message },
  ]

  if (orchestrated.answer) {
    updates.push({ role: 'assistant', content: orchestrated.answer })
  }

  appendToSessionHistory(effectiveSessionId, updates)

  // 4) DialogTurnResult を構築
  const result: DialogTurnResult = {
    sessionId: effectiveSessionId,
    answer: orchestrated.answer,
    steps: orchestrated.steps,
    final: orchestrated.final,
    needsClarification:
      orchestrated.needsClarification ?? multiStepPlan.needsClarification ?? false,
    clarifyingQuestions:
      orchestrated.clarifyingQuestions ?? multiStepPlan.clarifyingQuestions,
    meta: {
      multiStepPlan,
      orchestratorMode: 'local',
      needsClarification:
        orchestrated.needsClarification ?? multiStepPlan.needsClarification ?? false,
      clarifyingQuestions:
        orchestrated.clarifyingQuestions ?? multiStepPlan.clarifyingQuestions,
    },
  }

  return result
}