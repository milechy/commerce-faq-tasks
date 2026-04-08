// tests/widget/trackConversion.test.ts
// window.r2c.trackConversion() のユニットテスト
// widget.js の即時実行関数と同じロジックを分離してテスト

/**
 * widget.js が公開する trackConversion 関数を再現するファクトリ。
 * テスト内でブラウザ依存APIをすべてモック可能にするため、
 * 実際の widget.js を eval するのではなく同等のロジックを抽出して検証する。
 */
function makeTrackConversion(opts: {
  apiBase: string;
  apiKey: string;
  visitorId?: string;
  sessionId?: string;
  fetchImpl: typeof fetch;
}) {
  const { apiBase, apiKey, visitorId = '', sessionId = '', fetchImpl } = opts;

  return function trackConversion(conversionType: unknown, conversionValue?: unknown): void {
    if (!conversionType) {
      console.warn('[R2C] trackConversion: conversionType is required');
      return;
    }

    const payload = {
      visitor_id: visitorId || 'unknown',
      session_id: sessionId || 'unknown',
      events: [
        {
          event_type: 'chat_conversion',
          event_data: {
            conversion_type: conversionType,
            conversion_value: typeof conversionValue === 'number' ? conversionValue : null,
          },
          page_url: 'https://example.com/purchase/complete',
          referrer: 'https://example.com/cart',
        },
      ],
    };

    fetchImpl(apiBase + '/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(payload),
      keepalive: true,
    }).then(function (response: Response) {
      if (!response.ok) {
        console.warn('[R2C] trackConversion: server returned ' + response.status);
      }
    }).catch(function () {
      /* silent fail */
    });
  };
}

/**
 * r2cQueue drain ロジックを再現するヘルパー。
 * widget.js の trackConversion 登録後に実行されるブロックと等価。
 */
function drainR2cQueue(
  trackConversion: (type: string, value?: number) => void,
  queue: Array<{ type: string; conversionType: string; value?: number }> | null,
): void {
  if (queue && Array.isArray(queue)) {
    queue.forEach(function (item) {
      if (item.type === 'conversion') {
        trackConversion(item.conversionType, item.value);
      }
    });
  }
}

describe('window.r2c.trackConversion', () => {
  const API_BASE = 'https://api.r2c.biz';
  const API_KEY = 'test-key-abc123';

  let mockFetch: jest.Mock;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    mockFetch = jest.fn().mockResolvedValue({ ok: true } as Response);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // 1. 関数として存在する
  it('trackConversion は関数である', () => {
    const fn = makeTrackConversion({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl: mockFetch });
    expect(typeof fn).toBe('function');
  });

  // 2. conversionType 未指定時に console.warn が出る
  it('conversionType が falsy のとき console.warn を呼ぶ', () => {
    const fn = makeTrackConversion({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl: mockFetch });
    fn(undefined);
    expect(warnSpy).toHaveBeenCalledWith('[R2C] trackConversion: conversionType is required');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('conversionType が空文字のとき fetch しない', () => {
    const fn = makeTrackConversion({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl: mockFetch });
    fn('');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // 3. 正常呼び出し時に fetch が /api/events に POST される
  it('正常呼び出し時に /api/events に POST する', () => {
    const fn = makeTrackConversion({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl: mockFetch });
    fn('purchase', 50000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/api/events`);
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
  });

  // 4. payload に event_type: 'chat_conversion' が含まれる
  it('payload の event_type が chat_conversion である', () => {
    const fn = makeTrackConversion({
      apiBase: API_BASE,
      apiKey: API_KEY,
      visitorId: 'vid-test',
      sessionId: 'sid-test',
      fetchImpl: mockFetch,
    });
    fn('purchase', 12000);

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);

    expect(body.events[0].event_type).toBe('chat_conversion');
    expect(body.events[0].event_data.conversion_type).toBe('purchase');
    expect(body.events[0].event_data.conversion_value).toBe(12000);
    expect(body.visitor_id).toBe('vid-test');
    expect(body.session_id).toBe('sid-test');
  });

  it('conversion_value なしで呼ぶと event_data.conversion_value が null', () => {
    const fn = makeTrackConversion({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl: mockFetch });
    fn('inquiry');
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.events[0].event_data.conversion_value).toBeNull();
  });

  // 5. keepalive: true が設定されている
  it('keepalive: true が設定されている', () => {
    const fn = makeTrackConversion({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl: mockFetch });
    fn('signup');
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.keepalive).toBe(true);
  });

  it('x-api-key ヘッダーに apiKey が設定されている', () => {
    const fn = makeTrackConversion({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl: mockFetch });
    fn('purchase', 0);
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(API_KEY);
    expect(headers['Content-Type']).toBe('application/json');
  });

  // 6. fetch失敗時にエラーが throw されない（silent fail）
  it('fetch が reject しても例外が throw されない', async () => {
    const failFetch = jest.fn().mockRejectedValue(new Error('network error'));
    const fn = makeTrackConversion({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl: failFetch as unknown as typeof fetch });

    expect(() => fn('purchase', 1000)).not.toThrow();
    // reject の伝播が発生しないことを確認（次の tick まで待つ）
    await new Promise((r) => setTimeout(r, 0));
  });

  it('visitor_id / session_id 未取得時は "unknown" をフォールバックとして使う', () => {
    const fn = makeTrackConversion({
      apiBase: API_BASE,
      apiKey: API_KEY,
      visitorId: '',
      sessionId: '',
      fetchImpl: mockFetch,
    });
    fn('reservation');
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.visitor_id).toBe('unknown');
    expect(body.session_id).toBe('unknown');
  });

  // [P2] 非2xxレスポンスで console.warn が出る
  it('[P2] サーバーが非2xxを返したとき console.warn を呼ぶ', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 } as Response);
    const fn = makeTrackConversion({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl: mockFetch });
    fn('purchase', 5000);
    await new Promise((r) => setTimeout(r, 0));
    expect(warnSpy).toHaveBeenCalledWith('[R2C] trackConversion: server returned 401');
  });

  // [P1] r2cQueue drain: キューに積まれたイベントが処理される
  it('[P1] r2cQueue に積まれたコンバージョンが drain で処理される', () => {
    const fn = makeTrackConversion({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl: mockFetch });
    const queue = [
      { type: 'conversion', conversionType: 'purchase', value: 30000 },
      { type: 'conversion', conversionType: 'inquiry' },
    ];
    drainR2cQueue(fn as (type: string, value?: number) => void, queue);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const body0 = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body0.events[0].event_data.conversion_type).toBe('purchase');
    const body1 = JSON.parse((mockFetch.mock.calls[1][1] as RequestInit).body as string);
    expect(body1.events[0].event_data.conversion_type).toBe('inquiry');
  });

  // [P1] r2cQueue drain: type が 'conversion' 以外は無視される
  it('[P1] r2cQueue の type が conversion 以外のアイテムは無視される', () => {
    const fn = makeTrackConversion({ apiBase: API_BASE, apiKey: API_KEY, fetchImpl: mockFetch });
    const queue = [
      { type: 'pageview', conversionType: 'purchase', value: 1000 },
    ];
    drainR2cQueue(fn as (type: string, value?: number) => void, queue);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
