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
import { GPT_OSS_120B, GPT_OSS_20B, GROQ_COMPOUND, GROQ_COMPOUND_MINI } from '../../config/groqModels';

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

    const result = await callGroqWithModelFallback(makeParams(GPT_OSS_120B), { logger });

    expect(result).toBe('ok-response');
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(callSpy).toHaveBeenCalledWith(expect.objectContaining({ model: GPT_OSS_120B }));
    // 最初の試行が成功した場合は warn を出さない
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('1 回 model_not_found → フォールバック先で成功', async () => {
    const notFoundError = new GroqModelNotFoundError(404, '{"error":"model_not_found"}', GPT_OSS_120B);
    callSpy
      .mockRejectedValueOnce(notFoundError)
      .mockResolvedValueOnce('fallback-response');

    const result = await callGroqWithModelFallback(makeParams(GPT_OSS_120B), { logger });

    expect(result).toBe('fallback-response');
    expect(callSpy).toHaveBeenCalledTimes(2);
    // 2 回目はフォールバック先モデルで呼ばれること
    expect(callSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: GPT_OSS_20B }));
  });

  it('フォールバック発生時に warn ログが出力される（無言フォールバック禁止）', async () => {
    const notFoundError = new GroqModelNotFoundError(404, '{"error":"model_not_found"}', GPT_OSS_120B);
    callSpy
      .mockRejectedValueOnce(notFoundError)
      .mockResolvedValueOnce('ok');

    await callGroqWithModelFallback(makeParams(GPT_OSS_120B), { logger });

    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][0]).toMatchObject({
      originalModel: GPT_OSS_120B,
      failedModel: GPT_OSS_120B,
      fallbackModel: GPT_OSS_20B,
    });
    expect(warnMock.mock.calls[0][1]).toMatch(/groq-fallback/);
  });

  it('フォールバック成功後に info ログが出力される', async () => {
    const notFoundError = new GroqModelNotFoundError(404, '{"error":"model_not_found"}', GPT_OSS_120B);
    callSpy
      .mockRejectedValueOnce(notFoundError)
      .mockResolvedValueOnce('ok');

    await callGroqWithModelFallback(makeParams(GPT_OSS_120B), { logger });

    expect(infoMock).toHaveBeenCalledTimes(1);
    expect(infoMock.mock.calls[0][0]).toMatchObject({
      originalModel: GPT_OSS_120B,
      resolvedModel: GPT_OSS_20B,
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
    const notFoundError = new GroqModelNotFoundError(404, '{"error":"model_not_found"}', GPT_OSS_120B);
    callSpy
      .mockRejectedValueOnce(notFoundError)
      .mockResolvedValueOnce('ok');

    const onFallback = jest.fn();
    await callGroqWithModelFallback(makeParams(GPT_OSS_120B), { logger, onFallback });

    expect(onFallback).toHaveBeenCalledWith(GPT_OSS_120B, GPT_OSS_20B);
  });
});

// ---------------------------------------------------------------------------
// callGroqWithModelFallback — エラー系
// ---------------------------------------------------------------------------
describe('callGroqWithModelFallback — エラー系', () => {
  it('model_not_found 以外のエラーはそのまま再スローする', async () => {
    const serverError = new GroqServerError(500, 'internal error');
    callSpy.mockRejectedValueOnce(serverError);

    await expect(callGroqWithModelFallback(makeParams(GPT_OSS_120B), { logger }))
      .rejects.toBeInstanceOf(GroqServerError);

    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('429 エラーはフォールバックせずそのまま投げる', async () => {
    const rateLimitError = new GroqRateLimitError(429, 'rate limit exceeded');
    callSpy.mockRejectedValueOnce(rateLimitError);

    await expect(callGroqWithModelFallback(makeParams(GPT_OSS_120B), { logger }))
      .rejects.toBeInstanceOf(GroqRateLimitError);

    expect(callSpy).toHaveBeenCalledTimes(1);
  });

  it('GroqBadRequestError (非 model_not_found) はフォールバックしない', async () => {
    const badRequestError = new GroqBadRequestError(400, 'bad request');
    callSpy.mockRejectedValueOnce(badRequestError);

    await expect(callGroqWithModelFallback(makeParams(GPT_OSS_120B), { logger }))
      .rejects.toBeInstanceOf(GroqBadRequestError);

    expect(callSpy).toHaveBeenCalledTimes(1);
  });

  it('チェーン終端（GPT_OSS_20B）はフォールバック先なしでエラーを投げる', async () => {
    const notFoundError = new GroqModelNotFoundError(404, '{"error":"model_not_found"}', GPT_OSS_20B);
    callSpy.mockRejectedValue(notFoundError);

    await expect(callGroqWithModelFallback(makeParams(GPT_OSS_20B), { logger }))
      .rejects.toBeInstanceOf(GroqModelNotFoundError);

    // フォールバック試行なし（チェーン終端なので 1 回のみ）
    expect(callSpy).toHaveBeenCalledTimes(1);
    // warn ログが出力されること（チェーン終端の場合も無言は禁止）
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0][1]).toMatch(/no fallback available/);
  });

  it('フォールバック先でも model_not_found になった場合にチェーンを辿る', async () => {
    // GROQ_COMPOUND → GROQ_COMPOUND_MINI → GPT_OSS_120B と辿る
    const notFoundForCompound = new GroqModelNotFoundError(404, '{"error":"model_not_found"}', GROQ_COMPOUND);
    const notFoundForMini = new GroqModelNotFoundError(404, '{"error":"model_not_found"}', GROQ_COMPOUND_MINI);
    callSpy
      .mockRejectedValueOnce(notFoundForCompound)
      .mockRejectedValueOnce(notFoundForMini)
      .mockResolvedValueOnce('final-fallback');

    const result = await callGroqWithModelFallback(makeParams(GROQ_COMPOUND), { logger });

    expect(result).toBe('final-fallback');
    expect(callSpy).toHaveBeenCalledTimes(3);
    expect(callSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: GROQ_COMPOUND_MINI }));
    expect(callSpy).toHaveBeenNthCalledWith(3, expect.objectContaining({ model: GPT_OSS_120B }));
    // warn は 2 回（各フォールバック発生時）
    expect(warnMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// reasoning_effort（gpt-oss の推論トークン対策）
// ---------------------------------------------------------------------------
// callSpy(groqClient.call の spy)を経由せず、実際に組み立てられるリクエストボディを検証する。
// 2026-08-23: gpt-oss は推論トークンを max_tokens から消費するため、この指定が無いと
// 小さい max_tokens の呼び出しで本文が空になる（本番のアバターチャット無言停止の原因）。
describe('groqClient — gpt-oss への reasoning_effort 付与', () => {
  const origFetch = global.fetch;
  const origKey = process.env.GROQ_API_KEY;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test-key';
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    });
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    (global as any).fetch = origFetch;
    if (origKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = origKey;
  });

  const sentBody = () => JSON.parse(fetchMock.mock.calls[0]![1].body);

  it('call: gpt-oss には reasoning_effort=low が入る', async () => {
    await groqClient.call({ model: GPT_OSS_120B, messages: [{ role: 'user', content: 'hi' }] });
    expect(sentBody().reasoning_effort).toBe('low');
  });

  it('callWithUsage: gpt-oss には reasoning_effort=low が入る', async () => {
    await groqClient.callWithUsage({
      model: GPT_OSS_20B,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(sentBody().reasoning_effort).toBe('low');
  });

  it('compound 系には付かない（無条件付与への退化を防ぐ）', async () => {
    await groqClient.call({ model: GROQ_COMPOUND, messages: [{ role: 'user', content: 'hi' }] });
    expect('reasoning_effort' in sentBody()).toBe(false);

    fetchMock.mockClear();
    await groqClient.call({ model: GROQ_COMPOUND_MINI, messages: [{ role: 'user', content: 'hi' }] });
    expect('reasoning_effort' in sentBody()).toBe(false);
  });

  it('既存パラメータ(model/messages/temperature/max_tokens)を壊さない', async () => {
    await groqClient.call({
      model: GPT_OSS_120B,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      maxTokens: 300,
    });
    const b = sentBody();
    expect(b.model).toBe(GPT_OSS_120B);
    expect(b.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(b.temperature).toBe(0.5);
    expect(b.max_tokens).toBe(300);
    expect(b.reasoning_effort).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// call / callWithUsage の実装共有（重複解消の回帰防止）
// ---------------------------------------------------------------------------
// 2026-08-23: 以前は 2 メソッドがリクエスト組み立て・エラー分類・レスポンス検証を丸ごと
// 複製しており、#847 の reasoning_effort 追加では同じ 2 行を両方へ手で入れる必要があった。
// 片方を忘れてもテストが無ければ気づけない（例外にならず本文が空になるだけ）ため、
// 「両者が同じリクエストを送り、同じ例外を投げる」ことをここで固定する。
describe('groqClient — call と callWithUsage が実装を共有する', () => {
  const origFetch = global.fetch;
  const origKey = process.env.GROQ_API_KEY;
  let fetchMock: jest.Mock;

  const okResponse = () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'shared-ok' } }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    }),
  });

  const failing = (status: number, body: string, retryAfter: string | null = null) => ({
    ok: false,
    status,
    text: async () => body,
    headers: { get: (name: string) => (name === 'retry-after' ? retryAfter : null) },
  });

  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test-key';
    fetchMock = jest.fn().mockResolvedValue(okResponse());
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    (global as any).fetch = origFetch;
    if (origKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = origKey;
  });

  const params: GroqCallParams = {
    model: GPT_OSS_120B,
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.42,
    maxTokens: 321,
  };

  it('【最重要】両者が完全に同一のリクエストを送る（片肺修正の再発防止）', async () => {
    await groqClient.call(params);
    const [callUrl, callInit] = fetchMock.mock.calls[0]!;

    fetchMock.mockClear();
    await groqClient.callWithUsage(params);
    const [usageUrl, usageInit] = fetchMock.mock.calls[0]!;

    expect(usageUrl).toBe(callUrl);
    expect(usageInit.method).toBe(callInit.method);
    expect(usageInit.headers).toEqual(callInit.headers);
    // body は文字列として一致すること（キー順の差も許さない = 同一コードが組み立てた証明）
    expect(usageInit.body).toBe(callInit.body);
  });

  it('デフォルト値(temperature=0 / max_tokens=512)も両者で一致する', async () => {
    const bare: GroqCallParams = { model: GROQ_COMPOUND, messages: [{ role: 'user', content: 'x' }] };

    await groqClient.call(bare);
    const callBody = fetchMock.mock.calls[0]![1].body;

    fetchMock.mockClear();
    await groqClient.callWithUsage(bare);
    const usageBody = fetchMock.mock.calls[0]![1].body;

    expect(usageBody).toBe(callBody);
    const parsed = JSON.parse(callBody);
    expect(parsed.temperature).toBe(0);
    expect(parsed.max_tokens).toBe(512);
  });

  const errorCases: Array<{ label: string; status: number; body: string; expected: new (...a: any[]) => Error }> = [
    { label: '429', status: 429, body: 'rate limited', expected: GroqRateLimitError },
    { label: '404 + model_not_found', status: 404, body: '{"error":{"code":"model_not_found"}}', expected: GroqModelNotFoundError },
    { label: '404 (model_not_found でない)', status: 404, body: 'plain not found', expected: GroqBadRequestError },
    { label: '500', status: 500, body: 'boom', expected: GroqServerError },
    { label: '400', status: 400, body: 'bad request', expected: GroqBadRequestError },
  ];

  errorCases.forEach(({ label, status, body, expected }) => {
    it(`${label} は call / callWithUsage の両方で同じ例外クラスになる`, async () => {
      fetchMock.mockResolvedValue(failing(status, body));

      await expect(groqClient.call(params)).rejects.toBeInstanceOf(expected);
      await expect(groqClient.callWithUsage(params)).rejects.toBeInstanceOf(expected);
    });
  });

  it('retry-after ヘッダの解釈が両者で一致する', async () => {
    fetchMock.mockResolvedValue(failing(429, 'slow down', '2'));

    const capture = async (fn: () => Promise<unknown>): Promise<GroqRateLimitError> => {
      try {
        await fn();
      } catch (err) {
        return err as GroqRateLimitError;
      }
      throw new Error('expected GroqRateLimitError to be thrown');
    };

    const fromCall = await capture(() => groqClient.call(params));
    const fromUsage = await capture(() => groqClient.callWithUsage(params));

    expect(fromCall.retryAfterMs).toBe(2000);
    expect(fromUsage.retryAfterMs).toBe(2000);
  });

  it('content が無いレスポンスで両者とも同じメッセージのエラーを投げる', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) });

    await expect(groqClient.call(params)).rejects.toThrow('Groq API response has no message content');
    await expect(groqClient.callWithUsage(params)).rejects.toThrow('Groq API response has no message content');
  });

  it('GROQ_API_KEY 未設定で両者とも同じエラーを投げる', async () => {
    delete process.env.GROQ_API_KEY;

    await expect(groqClient.call(params)).rejects.toThrow('GROQ_API_KEY is not set');
    await expect(groqClient.callWithUsage(params)).rejects.toThrow('GROQ_API_KEY is not set');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('戻り値の形だけが違う: call は content のみ / callWithUsage は usage 付き', async () => {
    await expect(groqClient.call(params)).resolves.toBe('shared-ok');
    await expect(groqClient.callWithUsage(params)).resolves.toEqual({
      content: 'shared-ok',
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
  });

  it('usage が片方欠けている場合は undefined（callWithUsage の契約を維持）', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'shared-ok' } }],
        usage: { prompt_tokens: 3 },
      }),
    });

    await expect(groqClient.callWithUsage(params)).resolves.toEqual({
      content: 'shared-ok',
      usage: undefined,
    });
    // call 側は usage を無視して content だけ返す
    await expect(groqClient.call(params)).resolves.toBe('shared-ok');
  });
});
