// tests/phase47/bookStructurizer.test.ts
// Phase47 Stream A: bookStructurizer unit tests

const mockQuery = jest.fn();
const mockPool = { query: mockQuery };

jest.mock('../../src/lib/db', () => ({ getPool: () => mockPool }));
jest.mock('../../src/lib/gemini/client', () => ({
  callGeminiJudge: jest.fn(),
}));
jest.mock('../../src/agent/llm/openaiEmbeddingClient', () => ({
  embedText: jest.fn(),
}));
jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
}));

import { callGeminiJudge } from '../../src/lib/gemini/client';
import { embedText } from '../../src/agent/llm/openaiEmbeddingClient';
import { readFile } from 'fs/promises';
import { structurizeBook } from '../../src/agent/knowledge/bookStructurizer';

const mockCallGemini = callGeminiJudge as jest.MockedFunction<typeof callGeminiJudge>;
const mockEmbedText = embedText as jest.MockedFunction<typeof embedText>;
const mockReadFile = readFile as jest.MockedFunction<typeof readFile>;

const PROMPT_TEMPLATE = `テスト用プロンプト\n{{CHUNK_TEXT}}`;
const DUMMY_VECTOR = Array.from({ length: 1536 }, () => 0.1);

const PRINCIPLE_RESPONSE = JSON.stringify([
  {
    situation: '顧客が価格に抵抗している状況',
    resistance: '他社のほうが安いと主張する',
    principle: 'アンカリング効果',
    contraindication: '顧客が明確に予算オーバーの場合',
    example: 'このグレードは通常○○万円ですが本日特別価格でご案内できます',
    failure_example: '高すぎるアンカーは不信感を招く',
  },
]);

const FULL_TEXT = `返報性の原理とは、相手から何かを受け取ると、お返しをしなければならないという心理的な負債感のことである。

アンカリング効果とは、最初に提示された数字が判断の基準点となる心理的なバイアスである。この効果を利用すると価格交渉を有利に進めることができる。`;

describe('structurizeBook', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockCallGemini.mockReset();
    mockEmbedText.mockReset();
    mockReadFile.mockReset();

    process.env['BOOK_STRUCTURIZE_ENABLED'] = 'true';
    mockReadFile.mockResolvedValue(PROMPT_TEMPLATE as unknown as Buffer);
    mockEmbedText.mockResolvedValue(DUMMY_VECTOR);
    mockQuery.mockResolvedValue({ rows: [{ id: 100 }] });
  });

  afterEach(() => {
    delete process.env['BOOK_STRUCTURIZE_ENABLED'];
  });

  it('1. returns empty result when BOOK_STRUCTURIZE_ENABLED is not true', async () => {
    process.env['BOOK_STRUCTURIZE_ENABLED'] = 'false';

    const result = await structurizeBook('tenant-a', 1, FULL_TEXT);

    expect(result.totalChunks).toBe(0);
    expect(result.structuredCount).toBe(0);
    expect(mockCallGemini).not.toHaveBeenCalled();
  });

  it('2. returns empty result when fullText is empty', async () => {
    const result = await structurizeBook('tenant-a', 1, '');

    expect(result.totalChunks).toBe(0);
    expect(mockCallGemini).not.toHaveBeenCalled();
  });

  it('3. happy path: processes chunks, embeds, saves to DB, returns principles', async () => {
    mockCallGemini.mockResolvedValue(PRINCIPLE_RESPONSE);

    const result = await structurizeBook('tenant-a', 1, FULL_TEXT);

    expect(result.totalChunks).toBeGreaterThan(0);
    expect(result.structuredCount).toBeGreaterThan(0);
    expect(result.principles.length).toBeGreaterThan(0);
    expect(result.principles[0]!.principle).toBe('アンカリング効果');

    // DB insert should have been called
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO faq_embeddings'),
      expect.any(Array),
    );
  });

  it('4. skips chunks when Gemini returns empty array []', async () => {
    mockCallGemini.mockResolvedValue('[]');

    const result = await structurizeBook('tenant-a', 1, FULL_TEXT);

    expect(result.skippedCount).toBeGreaterThan(0);
    expect(result.structuredCount).toBe(0);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('5. skips chunks when Gemini returns no JSON array', async () => {
    mockCallGemini.mockResolvedValue('目次ページのため原則なし。');

    const result = await structurizeBook('tenant-a', 1, FULL_TEXT);

    expect(result.skippedCount).toBeGreaterThan(0);
    expect(result.structuredCount).toBe(0);
  });

  it('6. truncates each principle field to 200 chars', async () => {
    const longValue = 'A'.repeat(300);
    const longPrinciple = JSON.stringify([
      {
        situation: longValue,
        resistance: longValue,
        principle: longValue,
        contraindication: longValue,
        example: longValue,
        failure_example: longValue,
      },
    ]);
    mockCallGemini.mockResolvedValue(longPrinciple);

    const result = await structurizeBook('tenant-a', 1, FULL_TEXT);

    const p = result.principles[0];
    expect(p).toBeDefined();
    expect(p!.situation).toHaveLength(200);
    expect(p!.resistance).toHaveLength(200);
    expect(p!.principle).toHaveLength(200);
    expect(p!.contraindication).toHaveLength(200);
    expect(p!.example).toHaveLength(200);
    expect(p!.failure_example).toHaveLength(200);
  });

  it('7. continues processing after single Gemini failure (non-consecutive)', async () => {
    // First call fails, second succeeds
    mockCallGemini
      .mockRejectedValueOnce(new Error('Gemini error'))
      .mockResolvedValue(PRINCIPLE_RESPONSE);

    const result = await structurizeBook('tenant-a', 1, FULL_TEXT);

    expect(result.failedCount).toBeGreaterThanOrEqual(1);
    expect(result.structuredCount).toBeGreaterThanOrEqual(1);
  });

  it('8. aborts early after 5 consecutive Gemini failures', async () => {
    // Create text with many paragraphs to produce >5 chunks
    const manyParas = Array.from({ length: 10 }, (_, i) => `段落${i + 1}のテキストです。これは長い段落です。`).join('\n\n');
    mockCallGemini.mockRejectedValue(new Error('Gemini error'));

    const result = await structurizeBook('tenant-a', 1, manyParas);

    expect(result.failedCount).toBeGreaterThanOrEqual(5);
    // Should have fewer successful calls than total chunks due to early abort
    expect(result.structuredCount).toBe(0);
  });

  it('9. counts failedCount when embedText throws', async () => {
    mockCallGemini.mockResolvedValue(PRINCIPLE_RESPONSE);
    mockEmbedText.mockRejectedValue(new Error('embedding error'));

    const result = await structurizeBook('tenant-a', 1, FULL_TEXT);

    expect(result.failedCount).toBeGreaterThan(0);
    expect(result.structuredCount).toBe(0);
  });

  it('10. counts failedCount when DB insert throws', async () => {
    mockCallGemini.mockResolvedValue(PRINCIPLE_RESPONSE);
    mockQuery.mockRejectedValue(new Error('DB error'));

    const result = await structurizeBook('tenant-a', 1, FULL_TEXT);

    expect(result.failedCount).toBeGreaterThan(0);
    expect(result.structuredCount).toBe(0);
  });

  it('11. never throws on any error', async () => {
    mockReadFile.mockRejectedValue(new Error('file not found'));

    await expect(structurizeBook('tenant-a', 1, FULL_TEXT)).resolves.toBeDefined();
  });

  it('12. parses principles when Gemini wraps response in ```json block', async () => {
    // Gemini occasionally wraps output in markdown code fences
    const fencedResponse = `\`\`\`json\n${PRINCIPLE_RESPONSE}\n\`\`\``;
    mockCallGemini.mockResolvedValue(fencedResponse);

    const result = await structurizeBook('tenant-a', 1, FULL_TEXT);

    expect(result.structuredCount).toBeGreaterThan(0);
    expect(result.skippedCount).toBe(0);
    expect(result.principles[0]!.principle).toBe('アンカリング効果');
  });

  it('13. prompt template has {{CHUNK_TEXT}} replaced with chunk content', async () => {
    mockCallGemini.mockResolvedValue('[]');

    await structurizeBook('tenant-a', 1, '単一のテスト段落です。');

    expect(mockCallGemini).toHaveBeenCalledWith(
      expect.stringContaining('単一のテスト段落です。'),
    );
    expect(mockCallGemini).not.toHaveBeenCalledWith(
      expect.stringContaining('{{CHUNK_TEXT}}'),
    );
  });
});
