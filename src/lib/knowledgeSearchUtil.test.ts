// src/lib/knowledgeSearchUtil.test.ts
// GID 1217808323836843: searchKnowledgeForSuggestion が tenantId をスコープに持ちながら
// embedText への引き渡しを忘れ、埋め込みコストが tenant_id='unknown' として計上され
// 続けていた（/admin/billing 未解決利用 522件の主因）。再発防止テスト。

jest.mock('./db', () => ({
  pool: { query: jest.fn() },
}));
jest.mock('../agent/llm/openaiEmbeddingClient', () => ({
  embedText: jest.fn(),
}));
jest.mock('./crypto/textEncrypt', () => ({
  decryptText: jest.fn((v: string) => v),
}));

import { searchKnowledgeForSuggestion } from './knowledgeSearchUtil';
import { pool } from './db';
import { embedText } from '../agent/llm/openaiEmbeddingClient';

const mockEmbedText = embedText as jest.MockedFunction<typeof embedText>;
const mockQuery = (pool as unknown as { query: jest.Mock }).query;

describe('searchKnowledgeForSuggestion: tenantId の embedText への伝播', () => {
  beforeEach(() => {
    mockEmbedText.mockReset();
    mockQuery.mockReset();
    mockEmbedText.mockResolvedValue([0.1, 0.2, 0.3]);
    mockQuery.mockResolvedValue({ rows: [] });
  });

  it('embedText に実 tenantId を渡す（tenant_id="unknown" 計上を防ぐ）', async () => {
    await searchKnowledgeForSuggestion('carnation', '営業時間は？');

    expect(mockEmbedText).toHaveBeenCalledWith('営業時間は？', { tenantId: 'carnation' });
  });

  it('tenantId が空文字なら embedText を呼ばずに空配列を返す', async () => {
    const result = await searchKnowledgeForSuggestion('', 'クエリ');

    expect(result).toEqual({ results: [] });
    expect(mockEmbedText).not.toHaveBeenCalled();
  });
});
