// tests/phase60/knowledgeSearchUtil.test.ts
// Phase60-A: searchKnowledgeForSuggestion / formatKnowledgeContext ユニットテスト

const mockEmbedText = jest.fn();
const mockQuery = jest.fn();
const mockDecryptText = jest.fn((s: string) => s); // 暗号化なしをデフォルトとして扱う

jest.mock('../../src/agent/llm/openaiEmbeddingClient', () => ({
  embedText: mockEmbedText,
}));
jest.mock('../../src/lib/db', () => ({
  pool: { query: mockQuery },
}));
jest.mock('../../src/lib/crypto/textEncrypt', () => ({
  decryptText: mockDecryptText,
}));
jest.mock('../../src/lib/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import {
  searchKnowledgeForSuggestion,
  formatKnowledgeContext,
  KnowledgeContext,
} from '../../src/lib/knowledgeSearchUtil';

const DUMMY_EMBEDDING = Array.from({ length: 1536 }, (_, i) => i * 0.001);

const DB_ROWS = [
  { text: '返報性の原理とは相手に何かをしてもらうとお返しをしたくなる心理です。', score: 0.89, source: 'book' },
  { text: '当社の返品ポリシーは購入後30日以内です。', score: 0.82, source: 'faq' },
];

describe('searchKnowledgeForSuggestion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEmbedText.mockResolvedValue(DUMMY_EMBEDDING);
    mockQuery.mockResolvedValue({ rows: DB_ROWS });
  });

  // 1. pgvector 検索が呼び出される
  it('1. pgvector の faq_embeddings クエリを呼び出す', async () => {
    const result = await searchKnowledgeForSuggestion('tenant-a', '返品ポリシー');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('faq_embeddings');
    expect(result.results).toHaveLength(2);
  });

  // 2. tenant_id + 'global' の両方が検索対象
  it('2. WHERE 句に tenant_id と global が含まれる', async () => {
    await searchKnowledgeForSuggestion('tenant-b', 'テスト');
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("tenant_id = 'global'");
    expect(params[1]).toBe('tenant-b');
  });

  // 3. 結果が maxCharsPerResult (200文字) で切り詰められる
  it('3. テキストが maxCharsPerResult で切り詰められる', async () => {
    const longText = 'あ'.repeat(300); // 300文字
    mockQuery.mockResolvedValueOnce({ rows: [{ text: longText, score: 0.9, source: 'faq' }] });
    mockDecryptText.mockImplementationOnce((s: string) => s); // 素通し

    const result = await searchKnowledgeForSuggestion('tenant-c', 'query', { maxCharsPerResult: 200 });
    expect(result.results[0]!.text).toHaveLength(200);
  });

  // 4. embedding生成失敗時に空配列を返す（silent fail）
  it('4. embedText が throw しても空配列を返す', async () => {
    mockEmbedText.mockRejectedValueOnce(new Error('OpenAI API error'));
    const result = await searchKnowledgeForSuggestion('tenant-d', 'query');
    expect(result.results).toHaveLength(0);
  });

  it('4b. DBクエリが失敗しても空配列を返す', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB connection error'));
    const result = await searchKnowledgeForSuggestion('tenant-e', 'query');
    expect(result.results).toHaveLength(0);
  });

  it('tenantId が空のとき空配列を即時返す', async () => {
    const result = await searchKnowledgeForSuggestion('', 'query');
    expect(result.results).toHaveLength(0);
    expect(mockEmbedText).not.toHaveBeenCalled();
  });

  it('query が空白のとき空配列を即時返す', async () => {
    const result = await searchKnowledgeForSuggestion('tenant-a', '  ');
    expect(result.results).toHaveLength(0);
    expect(mockEmbedText).not.toHaveBeenCalled();
  });
});

describe('formatKnowledgeContext', () => {
  // 5. 正しいフォーマットで文字列を返す
  it('5. 参考番号・source・score を含む文字列を返す', () => {
    const ctx: KnowledgeContext = {
      results: [
        { text: '返報性の原理', score: 0.89, source: 'book' },
        { text: '返品ポリシー', score: 0.82, source: 'faq' },
      ],
    };
    const formatted = formatKnowledgeContext(ctx);
    expect(formatted).toContain('1. [book]');
    expect(formatted).toContain('返報性の原理');
    expect(formatted).toContain('(score: 0.89)');
    expect(formatted).toContain('2. [faq]');
    expect(formatted).toContain('(score: 0.82)');
  });

  // 6. 結果0件時に空文字列を返す
  it('6. results が空のとき空文字列を返す', () => {
    const ctx: KnowledgeContext = { results: [] };
    expect(formatKnowledgeContext(ctx)).toBe('');
  });

  it('score が境界値 (0/1) でも正常にフォーマットされる', () => {
    const ctx: KnowledgeContext = {
      results: [{ text: 'テスト', score: 1.0, source: 'faq' }],
    };
    const formatted = formatKnowledgeContext(ctx);
    expect(formatted).toContain('(score: 1.00)');
  });
});
