// src/agent/llm/groqClient.ts

import { getFallbackGroqModel } from '../../config/groqModels';

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
function getGroqGlobalBackoffRemainingMs(): number {
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
 * Groq が 404 / `model_not_found` を返したときに投げるエラー。
 *
 * 判定条件: HTTP 404、かつレスポンスボディに "model_not_found" または "model not found"
 * (大文字小文字問わず) が含まれる場合。単純な 404 は GroqBadRequestError のまま。
 */
export class GroqModelNotFoundError extends GroqApiError {
  /** 存在しないとして扱われたモデル ID */
  readonly modelId: string;

  constructor(status: number, bodySnippet: string, modelId: string) {
    super(`Groq model not found: "${modelId}"`, status, bodySnippet);
    this.name = 'GroqModelNotFoundError';
    this.modelId = modelId;
  }
}

/**
 * HTTP 404 レスポンスが「モデル不在」由来かを判定するヘルパー。
 * エラー識別を groqClient 内に閉じ込めるための内部ユーティリティ。
 */
export function isModelNotFoundBody(bodySnippet: string): boolean {
  const lower = bodySnippet.toLowerCase();
  return lower.includes('model_not_found') || lower.includes('model not found');
}

/** Groq API の usage フィールド */
export interface GroqUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface GroqCallWithUsageResult {
  content: string;
  usage?: GroqUsage;
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

  /**
   * Chat completion API を叩き、テキストと usage を返す。
   */
  callWithUsage(params: GroqCallParams): Promise<GroqCallWithUsageResult>
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

      if (response.status === 404 && isModelNotFoundBody(bodySnippet)) {
        throw new GroqModelNotFoundError(response.status, bodySnippet, model);
      }

      if (response.status >= 500) {
        throw new GroqServerError(response.status, bodySnippet);
      }

      throw new GroqBadRequestError(response.status, bodySnippet);
    }

    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }

    const content = json?.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new Error('Groq API response has no message content')
    }

    return content
  },

  async callWithUsage({ model, messages, temperature, maxTokens }: GroqCallParams): Promise<GroqCallWithUsageResult> {
    const apiKey = process.env.GROQ_API_KEY
    if (!apiKey) {
      throw new Error('GROQ_API_KEY is not set')
    }

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
      if (response.status === 429) throw new GroqRateLimitError(response.status, bodySnippet, retryAfterMs);
      if (response.status === 404 && isModelNotFoundBody(bodySnippet)) {
        throw new GroqModelNotFoundError(response.status, bodySnippet, model);
      }
      if (response.status >= 500) throw new GroqServerError(response.status, bodySnippet);
      throw new GroqBadRequestError(response.status, bodySnippet);
    }

    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
    const content = json?.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new Error('Groq API response has no message content')
    }

    const rawUsage = json?.usage;
    const usage: GroqUsage | undefined =
      typeof rawUsage?.prompt_tokens === 'number' && typeof rawUsage?.completion_tokens === 'number'
        ? { prompt_tokens: rawUsage.prompt_tokens, completion_tokens: rawUsage.completion_tokens }
        : undefined;

    return { content, usage };
  },
}

export interface GroqRetryOptions {
  maxRetries?: number;
  baseBackoffMs?: number;
  logger?: {
    warn: (obj: unknown, msg: string) => void;
    info?: (obj: unknown, msg: string) => void;
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

// ---------------------------------------------------------------------------
// Model-not-found フォールバック機構
// ---------------------------------------------------------------------------

export interface GroqFallbackOptions {
  /**
   * 呼び出し用途タグ（ログ集計用）。省略可。
   */
  tag?: string;
  /**
   * ログ出力先。省略した場合はログなし。
   * 注意: フォールバック発生は必ずログに残すこと（無言フォールバック禁止）。
   * Slack 通知が不要な場合でも warn レベルのログは必須。
   */
  logger?: {
    warn: (obj: unknown, msg: string) => void;
    info?: (obj: unknown, msg: string) => void;
  };
  /**
   * Slack 通知コールバック。省略可。
   * フォールバック発生時に呼び出されるので、Slack 通知が必要なら渡すこと。
   */
  onFallback?: (originalModel: string, fallbackModel: string) => void;
}

/**
 * Groq 呼び出しに 404 / model_not_found が返った場合、カタログ定義のフォールバック先へ
 * 自動退避するラッパー。
 *
 * - フォールバックチェーンは `src/config/groqModels.ts` の `GROQ_FALLBACK_CHAIN` を参照。
 * - フォールバック発生時は必ず warn ログを出力する（無言フォールバック禁止）。
 * - チェーン終端（退避先なし）または非 model_not_found エラーはそのまま上位へ投げる。
 * - 最大フォールバック回数は GROQ_FALLBACK_CHAIN の深さ（現在 2 段）に依存する。
 *
 * @param params   Groq 呼び出しパラメータ（model はフォールバックで上書きされる）
 * @param options  ログ・Slack 通知オプション
 * @returns        最初に成功したモデルの応答テキスト
 */
export async function callGroqWithModelFallback(
  params: GroqCallParams,
  options: GroqFallbackOptions = {},
): Promise<string> {
  const { logger, onFallback } = options;
  let currentModel = params.model;
  // フォールバック済みモデルを追跡（循環ループ防止）
  const visited = new Set<string>([currentModel]);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const result = await groqClient.call({ ...params, model: currentModel });
      if (currentModel !== params.model) {
        // 最終的にフォールバック先で成功した場合は info ログ
        logger?.info?.(
          { originalModel: params.model, resolvedModel: currentModel, tag: params.tag },
          '[groq-fallback] call succeeded on fallback model',
        );
      }
      return result;
    } catch (err) {
      if (!(err instanceof GroqModelNotFoundError)) {
        // model_not_found 以外のエラーはそのまま上位へ
        throw err;
      }

      const fallbackModel = getFallbackGroqModel(currentModel);

      if (fallbackModel === null) {
        // フォールバックチェーン終端: これ以上退避できない
        logger?.warn?.(
          {
            originalModel: params.model,
            failedModel: currentModel,
            tag: params.tag,
            status: err.status,
          },
          '[groq-fallback] model_not_found and no fallback available, giving up',
        );
        throw err;
      }

      if (visited.has(fallbackModel)) {
        // 循環ループ検知（カタログ設定ミスへの防衛）
        logger?.warn?.(
          {
            originalModel: params.model,
            failedModel: currentModel,
            fallbackModel,
            visited: [...visited],
            tag: params.tag,
          },
          '[groq-fallback] fallback cycle detected, giving up',
        );
        throw err;
      }

      // フォールバック発生を必ずログに残す（無言フォールバック禁止）
      logger?.warn?.(
        {
          originalModel: params.model,
          failedModel: currentModel,
          fallbackModel,
          tag: params.tag,
          status: err.status,
          bodySnippet: err.bodySnippet,
        },
        '[groq-fallback] model_not_found, falling back to alternative model',
      );

      // Slack 通知コールバックが設定されていれば呼ぶ
      onFallback?.(currentModel, fallbackModel);

      visited.add(fallbackModel);
      currentModel = fallbackModel;
      // ループして代替モデルで再試行
    }
  }
}