
// src/agent/orchestrator/crew/crewSchemas.ts

import type { DialogMessage, MultiStepQueryPlan } from '../../dialog/types'

export interface CrewOrchestratorRequest {
  conversation: DialogMessage[]
  locale: 'ja' | 'en'
  planOptions?: {
    topK?: number
    language?: 'ja' | 'en'
  }
  routeContext?: {
    contextTokens?: number
    recall?: number | null
    complexity?: 'low' | 'medium' | 'high' | null
    safetyTag?: 'none' | 'legal' | 'security' | 'policy' | string
  }
  debug?: boolean
}

export interface CrewOrchestratorResponse {
  plan: MultiStepQueryPlan
  debugInfo?: unknown
}