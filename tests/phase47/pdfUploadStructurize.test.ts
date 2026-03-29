// tests/phase47/pdfUploadStructurize.test.ts
// Phase47 Stream B: fire-and-forget structurizeBook フック統合テスト

jest.mock('../../src/lib/book-pipeline/pdfExtractor');
jest.mock('../../src/lib/book-pipeline/chunkSplitter');
jest.mock('../../src/lib/book-pipeline/structurizer');
jest.mock('../../src/lib/book-pipeline/embedAndStore');
jest.mock('../../src/agent/knowledge/bookStructurizer');

import { runBookPipeline } from '../../src/lib/book-pipeline/pipeline';
import { structurizeBook } from '../../src/agent/knowledge/bookStructurizer';
import { extractPdfText } from '../../src/lib/book-pipeline/pdfExtractor';
import { splitIntoChunks } from '../../src/lib/book-pipeline/chunkSplitter';
import { structurizeChunks } from '../../src/lib/book-pipeline/structurizer';
import { embedAndStore } from '../../src/lib/book-pipeline/embedAndStore';

const TENANT_ID = 'tenant-abc';
const BOOK_ID = 42;

const MOCK_PAGES = [
  { pageNumber: 1, text: 'テストテキスト' },
  { pageNumber: 2, text: '2ページ目' },
];
const MOCK_FULL_TEXT = 'テストテキスト\n\n2ページ目';

const MOCK_CHUNKS = [{ text: 'chunk1', chunkIndex: 0 }];
const MOCK_STRUCTURED_CHUNKS = [
  {
    question: 'Q',
    answer: 'A',
    summary: 'S',
    chunkIndex: 0,
    pageNumber: 1,
    category: 'general',
    keywords: [],
    confidence: 0.9,
  },
];

function makeMockDb() {
  let callCount = 0;
  return {
    query: jest.fn(async (sql: string) => {
      // First call: SELECT (lookup)
      if (sql.includes('SELECT')) {
        return {
          rows: [
            {
              id: BOOK_ID,
              tenant_id: TENANT_ID,
              storage_path: 'books/42.pdf',
              encryption_iv: null,
              status: 'uploaded',
            },
          ],
        };
      }
      // Subsequent calls: UPDATE (setStatus)
      callCount++;
      return { rows: [], rowCount: 1 };
    }),
  };
}

function setupMocks() {
  (extractPdfText as jest.Mock).mockResolvedValue({
    pages: MOCK_PAGES,
    pageCount: 2,
  });
  (splitIntoChunks as jest.Mock).mockReturnValue(MOCK_CHUNKS);
  (structurizeChunks as jest.Mock).mockResolvedValue(MOCK_STRUCTURED_CHUNKS);
  (embedAndStore as jest.Mock).mockResolvedValue([1]);
  (structurizeBook as jest.Mock).mockResolvedValue({ sections: [] });
}

beforeEach(() => {
  jest.clearAllMocks();
  setupMocks();
  delete process.env['BOOK_STRUCTURIZE_ENABLED'];
});

describe('Phase47 Stream B: fire-and-forget structurizeBook hook', () => {
  test('BOOK_STRUCTURIZE_ENABLED=true のとき、runBookPipeline 完了後に structurizeBook が呼ばれる', async () => {
    process.env['BOOK_STRUCTURIZE_ENABLED'] = 'true';

    const db = makeMockDb();
    const mockSupabase = {} as any;

    await runBookPipeline(BOOK_ID, { db: db as any, supabase: mockSupabase });

    // setImmediate のコールバックが実行されるまで待機
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(structurizeBook as jest.Mock).toHaveBeenCalledTimes(1);
    expect(structurizeBook as jest.Mock).toHaveBeenCalledWith(
      TENANT_ID,
      BOOK_ID,
      MOCK_FULL_TEXT,
    );
  });

  test('BOOK_STRUCTURIZE_ENABLED が false/未設定のとき、structurizeBook は呼ばれない', async () => {
    // env var は beforeEach で削除済み
    const db = makeMockDb();
    const mockSupabase = {} as any;

    await runBookPipeline(BOOK_ID, { db: db as any, supabase: mockSupabase });

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(structurizeBook as jest.Mock).not.toHaveBeenCalled();

    // false を明示的に設定した場合も同様
    jest.clearAllMocks();
    setupMocks();
    process.env['BOOK_STRUCTURIZE_ENABLED'] = 'false';
    const db2 = makeMockDb();

    await runBookPipeline(BOOK_ID, { db: db2 as any, supabase: mockSupabase });

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(structurizeBook as jest.Mock).not.toHaveBeenCalled();
  });

  test('structurizeBook が失敗しても runBookPipeline は成功する（non-blocking）', async () => {
    process.env['BOOK_STRUCTURIZE_ENABLED'] = 'true';

    (structurizeBook as jest.Mock).mockRejectedValue(
      new Error('Gemini API timeout'),
    );

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const db = makeMockDb();
    const mockSupabase = {} as any;

    const result = await runBookPipeline(BOOK_ID, {
      db: db as any,
      supabase: mockSupabase,
    });

    // runBookPipeline 自体は正常終了
    expect(result).toEqual({ chunkCount: 1, pageCount: 2 });

    // setImmediate 後にエラーが console.warn に記録される
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(warnSpy).toHaveBeenCalledWith(
      '[book-pipeline] structurizeBook failed (non-blocking):',
      'Gemini API timeout',
    );

    warnSpy.mockRestore();
  });
});
