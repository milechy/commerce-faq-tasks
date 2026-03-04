// src/agent/llm/groqClient.ts

export type GroqRole = 'system' | 'user' | 'assistant'

export interface GroqMessage {
  role: GroqRole
  content: string
}

export interface GroqCallParams {
  model: string;
  messages: GroqMessage[];
  temperature?: number;
  maxTokens?: number;
  /**
   * 呼び出し用途（planner / answer / summary など）を識別する任意のタグ。
   * ログ集計用なので、指定しなくてもよい。
   */
  tag?: string;
}

type GroqRateLimitState = {
  backoffUntil: number;
};

// プロセス内で共有する Groq の rate-limit 状態（簡易サーキットブレーカー）。
const groqRateLimitState: GroqRateLimitState = {
  backoffUntil: 0,
};

/**
 * 現在アクティブな Groq グローバル backoff の残り時間（ms）。
 * backoff 中でなければ 0 を返す。
 */
export function getGroqGlobalBackoffRemainingMs(): number {
  const now = Date.now();
  if (groqRateLimitState.backoffUntil <= now) return 0;
  return groqRateLimitState.backoffUntil - now;
}

export class GroqApiError extends Error {
  readonly status: number;
  readonly bodySnippet: string;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, bodySnippet: string, retryAfterMs?: number) {
    super(message);
    this.name = 'GroqApiError';
    this.status = status;
    this.bodySnippet = bodySnippet;
    this.retryAfterMs = retryAfterMs;
  }
}

export class GroqRateLimitError extends GroqApiError {
  constructor(status: number, bodySnippet: string, retryAfterMs?: number) {
    super('Groq rate limit exceeded', status, bodySnippet, retryAfterMs);
    this.name = 'GroqRateLimitError';
  }
}

export class GroqServerError extends GroqApiError {
  constructor(status: number, bodySnippet: string) {
    super('Groq server error', status, bodySnippet);
    this.name = 'GroqServerError';
  }
}

export class GroqBadRequestError extends GroqApiError {
  constructor(status: number, bodySnippet: string) {
    super('Groq bad request error', status, bodySnippet);
    this.name = 'GroqBadRequestError';
  }
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
      const text = await response.text();
      const bodySnippet = text.length > 500 ? `${text.slice(0, 500)}...` : text;

      const retryAfterHeader = response.headers.get('retry-after');
      let retryAfterMs: number | undefined;
      if (retryAfterHeader) {
        const retryAfterSeconds = Number(retryAfterHeader);
        if (!Number.isNaN(retryAfterSeconds) && retryAfterSeconds >= 0) {
          retryAfterMs = retryAfterSeconds * 1000;
        }
      }

      if (response.status === 429) {
        throw new GroqRateLimitError(response.status, bodySnippet, retryAfterMs);
      }

      if (response.status >= 500) {
        throw new GroqServerError(response.status, bodySnippet);
      }

      throw new GroqBadRequestError(response.status, bodySnippet);
    }

    const json: any = await response.json()

    const content = json?.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new Error('Groq API response has no message content')
    }

    return content
  },
}

export interface GroqRetryOptions {
  maxRetries?: number;
  baseBackoffMs?: number;
  logger?: {
    warn: (obj: any, msg: string) => void;
    info?: (obj: any, msg: string) => void;
  };
}

/**
 * Groq 429 (rate limit) を考慮したラッパー。
 *
 * - 429 の場合のみ短時間 backoff を挟んでリトライする
 * - リトライ上限を超えたらエラーをそのまま投げる（上位でフォールバックさせる）
 * - グローバル backoff 状態を考慮し、429 を受けたら backoffUntil を更新する
 */
export async function callGroqWith429Retry(
  params: GroqCallParams,
  options: GroqRetryOptions = {},
): Promise<string> {
  const { maxRetries = 1, baseBackoffMs = 200, logger } = options;

  const now = Date.now();
  const remainingBackoff = getGroqGlobalBackoffRemainingMs();
  if (remainingBackoff > 0) {
    // すでにグローバル backoff 中の場合は、実際の API コールを行わずに即座に 429 相当で返す。
    logger?.warn?.(
      { remainingBackoffMs: remainingBackoff },
      'Groq 429 global backoff active, skipping remote call',
    );
    throw new GroqRateLimitError(
      429,
      'Groq global backoff active',
      remainingBackoff,
    );
  }

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const attemptStartedAt = Date.now();
    try {
      const text = await groqClient.call(params);
      const latencyMs = Date.now() - attemptStartedAt;

      logger?.info?.(
        {
          model: params.model,
          tag: params.tag,
          latencyMs,
          attempt,
        },
        'Groq call success',
      );

      return text;
    } catch (err) {
      const latencyMs = Date.now() - attemptStartedAt;
      if (!(err instanceof GroqRateLimitError)) {
        // 429 以外はそのまま上位へ。ただしレイテンシは記録しておく。
        logger?.warn?.(
          {
            errorName: (err as any)?.name ?? 'Error',
            status: (err as any)?.status,
            latencyMs,
            attempt,
            tag: params.tag,
            model: params.model,
          },
          'Groq call failed (non-429)',
        );
        throw err;
      }

      const retryAfterMs =
        err.retryAfterMs && err.retryAfterMs > 0 ? err.retryAfterMs : baseBackoffMs;

      // 次回以降の呼び出し向けに、グローバル backoff を更新する。
      const nextBackoffUntil = Date.now() + retryAfterMs;
      if (nextBackoffUntil > groqRateLimitState.backoffUntil) {
        groqRateLimitState.backoffUntil = nextBackoffUntil;
      }

      if (attempt >= maxRetries) {
        logger?.warn?.(
          {
            status: err.status,
            retryAfterMs,
            attempt,
            backoffUntil: groqRateLimitState.backoffUntil,
            tag: params.tag,
            model: params.model,
            latencyMs,
          },
          'Groq 429 after retries, giving up',
        );
        throw err;
      }

      logger?.warn?.(
        {
          status: err.status,
          retryAfterMs,
          attempt,
          backoffUntil: groqRateLimitState.backoffUntil,
          tag: params.tag,
          model: params.model,
          latencyMs,
        },
        'Groq 429, backing off before retry',
      );

      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      attempt += 1;
      // ループして再試行
    }
  }
}