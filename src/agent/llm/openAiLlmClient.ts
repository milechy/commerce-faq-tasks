// src/agent/llm/openAiLlmClient.ts

import type { LlmClient } from '../flow/queryPlanner'

export type OpenAiLlmClientConfig = {
  /**
   * OpenAI などの API キー
   */
  apiKey: string
  /**
   * 使いたいモデル名（例: "gpt-4o-mini"）
   */
  model: string
  /**
   * ベース URL。
   * - OpenAI: "https://api.openai.com/v1/chat/completions"
   * - 互換 API: そのエンドポイント URL
   */
  baseUrl?: string
  /**
   * タイムアウト（ms）
   */
  timeoutMs?: number
  /**
   * 温度。デフォルト 0（安定寄り）
   */
  temperature?: number
}

/**
 * Chat Completions 互換 API を叩く LlmClient 実装。
 * - Node.js v20 の global fetch を利用
 * - OpenAI 互換エンドポイントを想定
 */
export class OpenAiLlmClient implements LlmClient {
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly temperature: number

  constructor(config: OpenAiLlmClientConfig) {
    this.apiKey = config.apiKey
    this.model = config.model
    this.baseUrl =
      config.baseUrl ?? 'https://api.openai.com/v1/chat/completions'
    this.timeoutMs = config.timeoutMs ?? 10_000
    this.temperature = config.temperature ?? 0
  }

  async complete(prompt: string): Promise<string> {
    const controller = new AbortController()
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.timeoutMs,
    )

    try {
      const res = await fetch(this.baseUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: this.temperature,
        }),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(
          `OpenAiLlmClient: HTTP ${res.status} ${res.statusText} ${text}`,
        )
      }

      const json: any = await res.json()

      const content: string | undefined =
        json?.choices?.[0]?.message?.content

      if (!content || typeof content !== 'string') {
        throw new Error('OpenAiLlmClient: no content in response')
      }

      return content
    } finally {
      clearTimeout(timeoutId)
    }
  }
}