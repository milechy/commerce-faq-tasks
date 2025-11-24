// src/agent/dialog/dialogAgent.ts

import crypto from 'node:crypto'
import { runDialogOrchestrator } from '../flow/dialogOrchestrator'
import { planMultiStepQueryWithLlmAsync } from '../flow/llmMultiStepPlannerRuntime'
import { planMultiStepQuery } from '../flow/multiStepPlanner'
import { appendToSessionHistory, getSessionHistory } from './contextStore'
import type { DialogMessage, DialogTurnInput, DialogTurnResult } from './types'

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