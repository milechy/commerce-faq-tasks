// src/agent/knowledge/bookStructurizer.tenantId.test.ts
// GID 1217808323836843: structurizeBook が tenantId をスコープに持ちながら
// callGeminiJudge / embedText への引き渡しを忘れ、trackUsage が tenant_id='unknown'
// で計上され続けていた。再発防止テスト。

jest.mock('../../lib/gemini/client', () => ({
  callGeminiJudge: jest.fn(),
}));
jest.mock('../../lib/db', () => ({
  getPool: jest.fn(() => ({ query: jest.fn().mockResolvedValue({ rows: [{ id: 1 }] }) })),
}));
jest.mock('../llm/openaiEmbeddingClient', () => ({
  embedText: jest.fn().mockResolvedValue([0.1, 0.2]),
}));

const ORIG_ENABLED = process.env['BOOK_STRUCTURIZE_ENABLED'];

import { structurizeBook } from './bookStructurizer';
import { callGeminiJudge } from '../../lib/gemini/client';
import { embedText } from '../llm/openaiEmbeddingClient';

const mockCallGeminiJudge = callGeminiJudge as jest.MockedFunction<typeof callGeminiJudge>;
const mockEmbedText = embedText as jest.MockedFunction<typeof embedText>;

describe('structurizeBook: tenantId の callGeminiJudge / embedText への伝播', () => {
  beforeEach(() => {
    process.env['BOOK_STRUCTURIZE_ENABLED'] = 'true';
    mockCallGeminiJudge.mockReset();
    mockEmbedText.mockReset();
    mockEmbedText.mockResolvedValue([0.1, 0.2]);
  });

  afterAll(() => {
    if (ORIG_ENABLED !== undefined) process.env['BOOK_STRUCTURIZE_ENABLED'] = ORIG_ENABLED;
    else delete process.env['BOOK_STRUCTURIZE_ENABLED'];
  });

  it('callGeminiJudge と embedText の両方に実 tenantId を渡す', async () => {
    mockCallGeminiJudge.mockResolvedValue(
      JSON.stringify([{
        situation: 'S', resistance: 'R', principle: 'P',
        contraindication: 'C', example: 'E', failure_example: 'F',
      }])
    );

    await structurizeBook('carnation', 42, '営業心理学における返報性の原則について説明する。');

    expect(mockCallGeminiJudge).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tenantId: 'carnation', billable: false }),
    );
    expect(mockEmbedText).toHaveBeenCalledWith(
      expect.any(String),
      { tenantId: 'carnation' },
    );
  });
});
