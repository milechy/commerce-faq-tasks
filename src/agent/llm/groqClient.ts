// src/agent/llm/groqClient.ts

export type GroqRole = 'system' | 'user' | 'assistant'

export interface GroqMessage {
  role: GroqRole
  content: string
}

export interface GroqCallParams {
  model: string
  messages: GroqMessage[]
  temperature?: number
  maxTokens?: number
}

/**
 * Groq クライアントインターフェース。
 *
 * Phase4 では:
 * - Planner / Answer 両方からこのインターフェースだけを叩く
 * - 実際の HTTP 実装はここに閉じ込める
 */
export interface GroqClient {
  /**
   * Chat completion API を叩き、生成されたテキストのみを返す。
   */
  call(params: GroqCallParams): Promise<string>
}

/**
 * デフォルトの Groq クライアント実装。
 *
 * NOTE:
 * - Node 18+ で global fetch が使える前提。
 * - それ以前の環境なら、node-fetch / undici などで polyfill してください。
 */
export const groqClient: GroqClient = {
  async call({ model, messages, temperature, maxTokens }: GroqCallParams): Promise<string> {
    const apiKey = process.env.GROQ_API_KEY
    if (!apiKey) {
      throw new Error('GROQ_API_KEY is not set')
    }

    // 主の LLM 実行パスとして Groq の compound runtime を利用する
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: temperature ?? 0,
        max_tokens: maxTokens ?? 512,
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Groq API error: ${response.status} ${text}`)
    }

    const json: any = await response.json()

    const content = json?.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new Error('Groq API response has no message content')
    }

    return content
  },
}