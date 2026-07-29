// tests/widget/recordAbExposure.test.ts
// widget.js の recordAbExposure() のユニットテスト
// GID 1216978855735482 follow-up: PR #561 が意図的に含めなかった widget.js 配線

/**
 * widget.js が持つ recordAbExposure 関数を再現するファクトリ。
 * trackConversion.test.ts と同じ方針で、実際の widget.js を eval するのではなく
 * 同等のロジックを抽出して検証する。
 */
function makeRecordAbExposure(opts: {
  apiBase: string;
  apiKey: string | null;
  abExperimentId: number | null;
  abVariant: 'a' | 'b' | null;
  conversationId: string;
  fetchImpl: typeof fetch;
}) {
  const { apiBase, apiKey, abExperimentId, abVariant, conversationId, fetchImpl } = opts;
  let sent = false;

  return function recordAbExposure(): void {
    if (sent || !abExperimentId || !abVariant || !apiKey) return;
    sent = true;
    try {
      fetchImpl(apiBase + '/v1/ab/avatar-exposure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({
          experiment_id: abExperimentId,
          variant: abVariant,
          session_id: conversationId,
        }),
        keepalive: true,
      }).then(function (res: Response) {
        if (!res.ok) {
          console.warn('[R2C] avatar-exposure: server returned ' + res.status);
        }
      }).catch(function () {
        /* silent fail */
      });
    } catch (_e) {
      /* silent fail */
    }
  };
}

describe('widget.js recordAbExposure', () => {
  const API_BASE = 'https://api.r2c.biz';
  const API_KEY = 'test-key-abc123';
  const SESSION_ID = '11111111-1111-4111-8111-111111111111';

  let mockFetch: jest.Mock;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    mockFetch = jest.fn().mockResolvedValue({ ok: true } as Response);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('abExperimentId が無いテナントでは fetch しない', () => {
    const fn = makeRecordAbExposure({
      apiBase: API_BASE,
      apiKey: API_KEY,
      abExperimentId: null,
      abVariant: null,
      conversationId: SESSION_ID,
      fetchImpl: mockFetch,
    });
    fn();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('abVariant が無い場合は fetch しない（実験IDのみ注入され割当が無いケース）', () => {
    const fn = makeRecordAbExposure({
      apiBase: API_BASE,
      apiKey: API_KEY,
      abExperimentId: 42,
      abVariant: null,
      conversationId: SESSION_ID,
      fetchImpl: mockFetch,
    });
    fn();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('apiKey が無い場合は fetch しない（未認証埋め込みは対象外）', () => {
    const fn = makeRecordAbExposure({
      apiBase: API_BASE,
      apiKey: null,
      abExperimentId: 42,
      abVariant: 'a',
      conversationId: SESSION_ID,
      fetchImpl: mockFetch,
    });
    fn();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('実験に割り当てられている場合 /v1/ab/avatar-exposure に POST する', () => {
    const fn = makeRecordAbExposure({
      apiBase: API_BASE,
      apiKey: API_KEY,
      abExperimentId: 42,
      abVariant: 'b',
      conversationId: SESSION_ID,
      fetchImpl: mockFetch,
    });
    fn();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/v1/ab/avatar-exposure`);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(API_KEY);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('payload に experiment_id / variant / session_id が正しく含まれる', () => {
    const fn = makeRecordAbExposure({
      apiBase: API_BASE,
      apiKey: API_KEY,
      abExperimentId: 42,
      abVariant: 'a',
      conversationId: SESSION_ID,
      fetchImpl: mockFetch,
    });
    fn();
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ experiment_id: 42, variant: 'a', session_id: SESSION_ID });
  });

  it('keepalive: true が設定されている（ページ離脱時の送信欠落を防ぐ）', () => {
    const fn = makeRecordAbExposure({
      apiBase: API_BASE,
      apiKey: API_KEY,
      abExperimentId: 42,
      abVariant: 'a',
      conversationId: SESSION_ID,
      fetchImpl: mockFetch,
    });
    fn();
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.keepalive).toBe(true);
  });

  it('2回目以降の呼び出しでは再送しない（1セッション1回のみ）', () => {
    const fn = makeRecordAbExposure({
      apiBase: API_BASE,
      apiKey: API_KEY,
      abExperimentId: 42,
      abVariant: 'a',
      conversationId: SESSION_ID,
      fetchImpl: mockFetch,
    });
    fn();
    fn();
    fn();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fetch が reject しても例外が throw されない（silent fail）', async () => {
    const failFetch = jest.fn().mockRejectedValue(new Error('network error'));
    const fn = makeRecordAbExposure({
      apiBase: API_BASE,
      apiKey: API_KEY,
      abExperimentId: 42,
      abVariant: 'a',
      conversationId: SESSION_ID,
      fetchImpl: failFetch as unknown as typeof fetch,
    });
    expect(() => fn()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('非2xxレスポンスで console.warn を呼ぶがチャット動作は継続する', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 } as Response);
    const fn = makeRecordAbExposure({
      apiBase: API_BASE,
      apiKey: API_KEY,
      abExperimentId: 42,
      abVariant: 'a',
      conversationId: SESSION_ID,
      fetchImpl: mockFetch,
    });
    fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(warnSpy).toHaveBeenCalledWith('[R2C] avatar-exposure: server returned 404');
  });
});
