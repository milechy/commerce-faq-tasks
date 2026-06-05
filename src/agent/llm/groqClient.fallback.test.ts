// src/agent/llm/groqClient.fallback.test.ts
// Groq 404/model_not_found フォールバック機構のユニットテスト

import * as groqClientModule from './groqClient';
import {
  GroqModelNotFoundError,
  GroqBadRequestError,
  GroqServerError,
  GroqRateLimitError,
  isModelNotFoundBody,
  callGroqWithModelFallback,
  GroqCallParams,
  groqClient,
} from './groqClient';
import { GROQ_VERSATILE_70B, GROQ_INSTANT_8B, GPT_OSS_120B, GPT_OSS_20B, GROQ_VERSATILE_70B as VERSATILE } from '../../config/groqModels';

function makeParams(model: string): GroqCallParams {
  return {
    model,
    messages: [{ role: 'user', content: 'hello' }],
  };
}

const warnMock = jest.fn();
const infoMock = jest.fn();
const logger = { warn: warnMock, info: infoMock };

let callSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  callSpy = jest.spyOn(groqClient, 'call');
});

afterEach(() => {
  callSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// isModelNotFoundBody
// ---------------------------------------------------------------------------
describe('isModelNotFoundBody', () => {
  it('model_not_found を含む文字列で true を返す', () => {
    expect(isModelNotFoundBody('{"error":{"code":"model_not_found"}}')).toBe(true);
  });

  it('model not found (空白区切り) を含む文字列で true を返す', () => {
    expect(isModelNotFoundBody('The model not found on this deployment')).toBe(true);
  });

  it('大文字混じりでも true を返す', () => {
    expect(isModelNotFoundBody('Model_Not_Found')).toBe(true);
  });

  it('関係ない文字列で false を返す', () => {
    expect(isModelNotFoundBody('{"error":"rate_limit_exceeded"}')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GroqModelNotFoundError クラス
// ---------------------------------------------------------------------------
describe('GroqModelNotFoundError', () => {
  it('正しいプロパティを持つ', () => {
    const err = new GroqModelNotFoundError(404, 'model_not_found body', 'some-model-id');
    expect(err.name).toBe('GroqModelNotFoundError');
    expect(err.status).toBe(404);
    expect(err.modelId).toBe('some-model-id');
    expect(err.message).toContain('some-model-id');
  });

  it('GroqBadRequestError と同じ基底クラス (GroqApiError) を持つ', () => {
    const err = new GroqModelNotFoundError(404, '', 'x');
    // GroqApiError の status プロパティが存在することを確認
    expect(typeof err.status).toBe('number');
    expect(typeof err.bodySnippet).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// callGroqWithModelFallback — 正常系
// ---------------------------------------------------------------------------
describe('callGroqWithModelFallback — 正常系', () => {
  it('最初の呼び出しが成功した場合はそのまま返す', async () => {
    callSpy.mockResolvedValueOnce('ok-response');

    const result = await callGroqWithModelFallback(makeParams(GROQ_VERSATILE_70B), { logger });

    expect(result).toBe('ok-response');
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(callSpy).toHaveBeenCalledWith(expect.objectContaining({ model: GROQ_VERSATILE_70B }));
    // 最初の試行が成功した場合は warn を出さない
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('1 回 model_not_found → フォールバック先で成功', async () => {
    const notFoundError = new GroqModelNotFoundError(404, '{"error":"model_not_found"}', GROQ_VERSATILE_70B);
    callSpy
      .mockRejectedValueOnce(notFoundError)
      .mockResolvedValueOnce('fallback-response');

    const result = await callGroqWithModelFallback(makeParams(GROQ_VERSATILE_70B), { logger });

    expect(result).toBe('fallback-response');
    expect(callSpy).toHaveBeenCalledTimes(2);
    // 2 回目はフォールバック先モデルで呼ばれること
    expect(callSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: GROQ_INSTANT_8B }));
  });

  it('フォールバック発生時に warn ログが出力される（無言フォールバック禁止）', async () => {
    const notFoundError = new GroqModelNotFoundError(404, '{"error":"model_not_found"}', GROQ_VERSATILE_70B);
    callSpy
      .mockRejectedValueOnce(notFoundError)
      .mockResolvedValueOnce('ok');

    await callGroqWithModelFallback(makeParams(GROQ_VERSATILE_70B), { logger });

    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][0]).toMatchObject({
      originalModel: GROQ_VERSATILE_70B,
      failedModel: GROQ_VERSATILE_70B,
      fallbackModel: GROQ_INSTANT_8B,
    });
    expect(warnMock.mock.calls[0][1]).toMatch(/groq-fallback/);
  });

  it('フォールバック成功後に info ログが出力される', async () => {
    const notFoundError = new GroqModelNotFoundError(404, '{"error":"model_not_found"}', GROQ_VERSATILE_70B);
    callSpy
      .mockRejectedValueOnce(notFoundError)
      .mockResolvedValueOnce('ok');

    await callGroqWithModelFallback(makeParams(GROQ_VERSATILE_70B), { logger });

    expect(infoMock).toHaveBeenCalledTimes(1);
    expect(infoMock.mock.calls[0][0]).toMatchObject({
      originalModel: GROQ_VERSATILE_70B,
      resolvedModel: GROQ_INSTANT_8B,
    });
  });

  it('GPT_OSS_120B → GPT_OSS_20B のチェーンが動作する', async () => {
    const notFoundError = new GroqModelNotFoundError(404, '{"error":"model_not_found"}', GPT_OSS_120B);
    callSpy
      .mockRejectedValueOnce(notFoundError)
      .mockResolvedValueOnce('oss-20b-response');

    const result = await callGroqWithModelFallback(makeParams(GPT_OSS_120B), { logger });

    expect(result).toBe('oss-20b-response');
    expect(callSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: GPT_OSS_20B }));
  });

  it('onFallback コールバックが呼ばれる', async () => {
    const notFoundError = new GroqModelNotFoundError(404, '{"error":"model_not_found"}', GROQ_VERSATILE_70B);
    callSpy
      .mockRejectedValueOnce(notFoundError)
      .mockResolvedValueOnce('ok');

    const onFallback = jest.fn();
    await callGroqWithModelFallback(makeParams(GROQ_VERSATILE_70B), { logger, onFallback });

    expect(onFallback).toHaveBeenCalledWith(GROQ_VERSATILE_70B, GROQ_INSTANT_8B);
  });
});

// ---------------------------------------------------------------------------
// callGroqWithModelFallback — エラー系
// ---------------------------------------------------------------------------
describe('callGroqWithModelFallback — エラー系', () => {
  it('model_not_found 以外のエラーはそのまま再スローする', async () => {
    const serverError = new GroqServerError(500, 'internal error');
    callSpy.mockRejectedValueOnce(serverError);

    await expect(callGroqWithModelFallback(makeParams(GROQ_VERSATILE_70B), { logger }))
      .rejects.toBeInstanceOf(GroqServerError);

    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('429 エラーはフォールバックせずそのまま投げる', async () => {
    const rateLimitError = new GroqRateLimitError(429, 'rate limit exceeded');
    callSpy.mockRejectedValueOnce(rateLimitError);

    await expect(callGroqWithModelFallback(makeParams(GROQ_VERSATILE_70B), { logger }))
      .rejects.toBeInstanceOf(GroqRateLimitError);

    expect(callSpy).toHaveBeenCalledTimes(1);
  });

  it('GroqBadRequestError (非 model_not_found) はフォールバックしない', async () => {
    const badRequestError = new GroqBadRequestError(400, 'bad request');
    callSpy.mockRejectedValueOnce(badRequestError);

    await expect(callGroqWithModelFallback(makeParams(GROQ_VERSATILE_70B), { logger }))
      .rejects.toBeInstanceOf(GroqBadRequestError);

    expect(callSpy).toHaveBeenCalledTimes(1);
  });

  it('チェーン終端（GROQ_INSTANT_8B）はフォールバック先なしでエラーを投げる', async () => {
    const notFoundError = new GroqModelNotFoundError(404, '{"error":"model_not_found"}', GROQ_INSTANT_8B);
    callSpy.mockRejectedValue(notFoundError);

    await expect(callGroqWithModelFallback(makeParams(GROQ_INSTANT_8B), { logger }))
      .rejects.toBeInstanceOf(GroqModelNotFoundError);

    // フォールバック試行なし（チェーン終端なので 1 回のみ）
    expect(callSpy).toHaveBeenCalledTimes(1);
    // warn ログが出力されること（チェーン終端の場合も無言は禁止）
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][1]).toMatch(/no fallback available/);
  });

  it('フォールバック先でも model_not_found になった場合にチェーンを辿る', async () => {
    // GPT_OSS_120B → GPT_OSS_20B → GROQ_VERSATILE_70B と辿る
    const notFoundFor120b = new GroqModelNotFoundError(404, '{"error":"model_not_found"}', GPT_OSS_120B);
    const notFoundFor20b = new GroqModelNotFoundError(404, '{"error":"model_not_found"}', GPT_OSS_20B);
    callSpy
      .mockRejectedValueOnce(notFoundFor120b)
      .mockRejectedValueOnce(notFoundFor20b)
      .mockResolvedValueOnce('final-fallback');

    const result = await callGroqWithModelFallback(makeParams(GPT_OSS_120B), { logger });

    expect(result).toBe('final-fallback');
    expect(callSpy).toHaveBeenCalledTimes(3);
    expect(callSpy).toHaveBeenNthCalledWith(3, expect.objectContaining({ model: GROQ_VERSATILE_70B }));
    // warn は 2 回（各フォールバック発生時）
    expect(warnMock).toHaveBeenCalledTimes(2);
  });
});
