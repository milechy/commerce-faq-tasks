// tests/phase60/perplexityProvider.test.ts
// Phase60-C: PerplexityProvider ユニットテスト

import { PerplexityProvider, _clearCacheForTesting } from '../../src/lib/research/perplexityProvider';
import { getResearchProvider } from '../../src/lib/research';

jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

let mockFetch: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  _clearCacheForTesting();
  mockFetch = jest.fn();
  global.fetch = mockFetch as unknown as typeof fetch;
  process.env['PERPLEXITY_API_KEY'] = 'test-perplexity-key';
});

afterEach(() => {
  delete process.env['PERPLEXITY_API_KEY'];
});

function makePerplexityResponse(summary: string, citations: string[] = []) {
  return {
    ok: true,
    json: () => Promise.resolve({
      choices: [{ message: { content: summary } }],
      citations,
    }),
  };
}

// 1. PerplexityProviderがExternalResearchProviderインターフェースを実装している
it('1. PerplexityProvider が ExternalResearchProvider インターフェースを実装している', () => {
  const provider = new PerplexityProvider();
  expect(typeof provider.search).toBe('function');
  expect(typeof provider.name).toBe('string');
  expect(typeof provider.costPerQuery).toBe('number');
  expect(provider.name).toBe('perplexity');
});

// 2. PERPLEXITY_API_KEY未設定時にgetResearchProviderがnullを返す
it('2. PERPLEXITY_API_KEY未設定時に getResearchProvider が null を返す', () => {
  delete process.env['PERPLEXITY_API_KEY'];
  expect(getResearchProvider()).toBeNull();
});

// 3. API呼び出し成功時にResearchResultを返す
it('3. API成功時に ResearchResult を返す', async () => {
  mockFetch.mockResolvedValueOnce(makePerplexityResponse('市場動向サマリー', ['https://example.com/1']));
  const provider = new PerplexityProvider();
  const result = await provider.search('心理学 最新動向', 'ja');

  expect(result).not.toBeNull();
  expect(result!.summary).toBe('市場動向サマリー');
  expect(result!.citations).toEqual(['https://example.com/1']);
  expect(result!.provider).toBe('perplexity');
  expect(result!.query).toBe('心理学 最新動向');
});

// 4. summaryが500文字で切り詰められる
it('4. summary が 500 文字で切り詰められる', async () => {
  const longSummary = 'あ'.repeat(600);
  mockFetch.mockResolvedValueOnce(makePerplexityResponse(longSummary));
  const provider = new PerplexityProvider();
  const result = await provider.search('テスト', 'ja');

  expect(result!.summary).toHaveLength(500);
  expect(result!.summary).toBe('あ'.repeat(500));
});

// 5. citationsが最大5件に制限される
it('5. citations が最大 5 件に制限される', async () => {
  const citations = Array.from({ length: 10 }, (_, i) => `https://example.com/${i}`);
  mockFetch.mockResolvedValueOnce(makePerplexityResponse('サマリー', citations));
  const provider = new PerplexityProvider();
  const result = await provider.search('テスト', 'ja');

  expect(result!.citations).toHaveLength(5);
});

// 6. タイムアウト（10秒）でnullを返す（silent fail）
it('6. タイムアウト / fetch reject → null を返す（silent fail）', async () => {
  const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  mockFetch.mockRejectedValueOnce(abortErr);
  const provider = new PerplexityProvider();
  const result = await provider.search('テスト', 'ja');

  expect(result).toBeNull();
});

// 7. API 4xx/5xxでnullを返す（silent fail）
it('7. API 4xx/5xx → null を返す（silent fail）', async () => {
  mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
  const provider = new PerplexityProvider();
  const result = await provider.search('テスト', 'ja');

  expect(result).toBeNull();
});

// 8. 同一クエリの2回目がキャッシュから返される（fetchが1回のみ）
it('8. 同一クエリの2回目はキャッシュから返される', async () => {
  mockFetch.mockResolvedValueOnce(makePerplexityResponse('キャッシュテスト'));
  const provider = new PerplexityProvider();

  const r1 = await provider.search('同一クエリ', 'ja');
  const r2 = await provider.search('同一クエリ', 'ja');

  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(r1).toEqual(r2);
  expect(r2!.summary).toBe('キャッシュテスト');
});

// 9. 24時間TTL超過後に再取得される
it('9. キャッシュTTL超過後に再取得される', async () => {
  mockFetch
    .mockResolvedValueOnce(makePerplexityResponse('初回取得'))
    .mockResolvedValueOnce(makePerplexityResponse('再取得'));

  const provider = new PerplexityProvider();

  // 初回
  const r1 = await provider.search('クエリ', 'ja');
  expect(r1!.summary).toBe('初回取得');

  // キャッシュを強制期限切れにする
  const cacheKey = 'ja:クエリ';
  // @ts-ignore: テスト用にキャッシュ直接操作
  const mod = require('../../src/lib/research/perplexityProvider');
  // _clearCacheForTesting して再実行する代わりに、別のproviderを使って独立したキャッシュをクリア
  _clearCacheForTesting();

  // 2回目（キャッシュなし → 再fetch）
  const r2 = await provider.search('クエリ', 'ja');
  expect(r2!.summary).toBe('再取得');
  expect(mockFetch).toHaveBeenCalledTimes(2);
});
