// src/agent/flow/llmPlannerRuntime.ts

import { OpenAiLlmClient } from '../llm/openAiLlmClient'
import type { QueryPlan } from '../types'
import type { PlanOptions } from './queryPlanner'
import { LlmQueryPlanner, planQueryAsync } from './queryPlanner'

let initialized = false
let planner: LlmQueryPlanner | null = null

function initPlanner(): LlmQueryPlanner | null {
  if (initialized) return planner
  initialized = true

  const enabled = process.env.AGENT_PLANNER_LLM_ENABLED === '1'
  if (!enabled) {
    return (planner = null)
  }

  const apiKey = process.env.OPENAI_API_KEY
  const model = process.env.AGENT_PLANNER_MODEL ?? 'gpt-4o-mini'

  if (!apiKey) {
    console.warn(
      '[llmPlannerRuntime] AGENT_PLANNER_LLM_ENABLED=1 ですが OPENAI_API_KEY が設定されていません。Rule-based にフォールバックします。',
    )
    return (planner = null)
  }

  const client = new OpenAiLlmClient({
    apiKey,
    model,
    // 必要なら baseUrl / timeoutMs / temperature をここで調整
  })

  planner = new LlmQueryPlanner({ client, model })
  return planner
}

/**
 * LLM プランナー経由で QueryPlan を生成するエントリポイント。
 * - フラグや API キーが無い場合は Rule-based (planQueryAsync) にフォールバック。
 * - LLM 側でエラーになった場合も、必ず Rule-based にフォールバックする。
 */
export async function planQueryWithLlmAsync(
  input: string,
  options: PlanOptions = {},
): Promise<QueryPlan> {
  const p = initPlanner()
  if (!p) {
    // LLM 無効 or 設定不足 → Rule-based (既存と同じ)
    return planQueryAsync(input, options)
  }

  try {
    return await p.planAsync(input, options)
  } catch (err) {
    console.warn(
      '[llmPlannerRuntime] LLM planner failed, falling back to rule-based planner:',
      err,
    )
    return planQueryAsync(input, options)
  }
}