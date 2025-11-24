
// src/agent/orchestrator/crew/crewClient.ts

import type {
  CrewOrchestratorRequest,
  CrewOrchestratorResponse,
} from './crewSchemas'

export interface CrewOrchestratorClientOptions {
  baseUrl: string
  apiKey?: string
  timeoutMs?: number
}

/**
 * Crew Orchestrator（例: Python CrewAI）へのポート定義。
 *
 * Phase3 ではポートのみ定義し、実際の HTTP 呼び出し実装は Phase4 で追加する。
 */
export class CrewOrchestratorClient {
  constructor(private readonly options: CrewOrchestratorClientOptions) {}

  /**
   * Multi-Step Query Plan を Crew Orchestrator に委譲して生成する。
   *
   * NOTE:
   * - Phase3 ではまだ実装しない。
   * - 実装時は fetch/axios などで POST /crew/orchestrator/plan を叩く想定。
   * - エラー時は呼び出し元で Rule-based planner にフォールバックできるよう、
   *   例外をそのまま投げる実装にする。
   */
  async planDialogTurn(
    payload: CrewOrchestratorRequest,
  ): Promise<CrewOrchestratorResponse> {
    throw new Error('CrewOrchestratorClient.planDialogTurn is not implemented yet.')
  }
}