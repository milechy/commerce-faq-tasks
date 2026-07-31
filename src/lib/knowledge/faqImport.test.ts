// src/lib/knowledge/faqImport.test.ts
//
// FAQ一括インポート共有ロジック（プレビュー生成・重複判定・コミット）の単体テスト。
// 外部依存（Groq / embedding / crypto / logger）はモックし、DB は Pool 互換のモックを渡す。

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockGroqCall = jest.fn();
jest.mock('../../agent/llm/groqClient', () => ({
  groqClient: { call: (...args: unknown[]) => mockGroqCall(...args) },
}));

const mockEmbedText = jest.fn();
jest.mock('../../agent/llm/openaiEmbeddingClient', () => ({
  embedText: (...args: unknown[]) => mockEmbedText(...args),
}));

jest.mock('../crypto/textEncrypt', () => ({
  encryptText: (s: string) => `enc(${s})`,
}));

import type { Pool } from 'pg';
import {
  textToFaqs,
  bigramSimilarity,
  attachDuplicateInfo,
  extractProductMeta,
  fetchExistingFaqRows,
  fetchExistingQuestions,
  generateTextFaqPreview,
  generateScrapeFaqPreview,
  commitTextFaqs,
  commitScrapeFaqs,
  insertEmbeddingAsync,
  DUPLICATE_THRESHOLD,
} from './faqImport';

function makeMockPool(queryImpl: jest.Mock): Pool {
  return { query: queryImpl } as unknown as Pool;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmbedText.mockResolvedValue([0.1, 0.2, 0.3]);
});

describe('bigramSimilarity', () => {
  it('完全一致は1.0', () => {
    expect(bigramSimilarity('営業時間は？', '営業時間は？')).toBe(1.0);
  });
  it('部分一致（片方がもう片方を包含）は閾値以上になる', () => {
    const score = bigramSimilarity('営業時間は', '営業時間を教えてください');
    expect(score).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
  });
  it('無関係な文字列は閾値未満', () => {
    const score = bigramSimilarity('返品は可能ですか', '駐車場はありますか');
    expect(score).toBeLessThan(DUPLICATE_THRESHOLD);
  });
});

describe('attachDuplicateInfo', () => {
  it('既存FAQと類似する質問には duplicate 情報が付く', () => {
    const result = attachDuplicateInfo(
      [{ question: '営業時間は', answer: '9-18時です' }],
      [{ question: '営業時間を教えてください', answer: '9時から18時です' }],
    );
    expect(result[0]!.duplicate).not.toBeNull();
    expect(result[0]!.duplicate?.existingQuestion).toBe('営業時間を教えてください');
  });
  it('類似する既存FAQがなければ duplicate は null', () => {
    const result = attachDuplicateInfo(
      [{ question: '返品は可能ですか', answer: '可能です' }],
      [{ question: '駐車場はありますか', answer: 'あります' }],
    );
    expect(result[0]!.duplicate).toBeNull();
  });
});

describe('extractProductMeta', () => {
  it('OGタグから image / price / cta_url を抽出する', () => {
    const html = `<html><head>
      <meta property="og:image" content="https://cdn.example.com/img.jpg" />
      <meta property="og:price:amount" content="1980" />
      <meta property="og:url" content="https://example.com/p/1" />
    </head></html>`;
    const meta = extractProductMeta(html, 'https://example.com/p/1');
    expect(meta.product_image_url).toBe('https://cdn.example.com/img.jpg');
    expect(meta.product_price).toBe('1980');
    expect(meta.product_cta_url).toBe('https://example.com/p/1');
  });

  it('JSON-LD Product があれば優先採用する', () => {
    const html = `<html><head>
      <script type="application/ld+json">
        {"@type": "Product", "image": "https://cdn.example.com/ld.jpg", "offers": {"price": "2980"}}
      </script>
    </head></html>`;
    const meta = extractProductMeta(html, 'https://example.com/p/1');
    expect(meta.product_image_url).toBe('https://cdn.example.com/ld.jpg');
    expect(meta.product_price).toBe('2980');
  });

  it('javascript: スキームは null に落とす（safeHttpUrlガード）', () => {
    const html = `<html><head>
      <meta property="og:image" content="javascript:alert(1)" />
    </head></html>`;
    const meta = extractProductMeta(html, 'https://example.com/p/1');
    expect(meta.product_image_url).toBeNull();
  });
});

describe('fetchExistingFaqRows / fetchExistingQuestions', () => {
  it('DBエラー時は non-fatal に空配列を返す', async () => {
    const db = makeMockPool(jest.fn().mockRejectedValue(new Error('db down')));
    await expect(fetchExistingFaqRows(db, 't1')).resolves.toEqual([]);
    await expect(fetchExistingQuestions(db, 't1')).resolves.toEqual([]);
  });

  it('正常時は行データを返す', async () => {
    const db = makeMockPool(jest.fn().mockResolvedValue({ rows: [{ question: 'Q1', answer: 'A1' }] }));
    await expect(fetchExistingFaqRows(db, 't1')).resolves.toEqual([{ question: 'Q1', answer: 'A1' }]);
  });
});

describe('textToFaqs', () => {
  it('Groqの応答からJSON配列を抽出しFaqEntry[]を返す', async () => {
    mockGroqCall.mockResolvedValue('[{"question":"Q1","answer":"A1","category":"general"}]');
    const faqs = await textToFaqs('十分な長さのテキスト。'.repeat(10));
    expect(faqs).toEqual([{ question: 'Q1', answer: 'A1', category: 'general' }]);
  });

  it('categoryOverride指定時は全FAQのカテゴリを上書きする', async () => {
    mockGroqCall.mockResolvedValue('[{"question":"Q1","answer":"A1","category":"general"}]');
    const faqs = await textToFaqs('十分な長さのテキスト。'.repeat(10), 'pricing');
    expect(faqs[0]!.category).toBe('pricing');
  });

  it('JSON配列が見つからない場合はエラーを投げる', async () => {
    mockGroqCall.mockResolvedValue('申し訳ありません、うまく生成できませんでした');
    await expect(textToFaqs('十分な長さのテキスト。'.repeat(10))).rejects.toThrow();
  });
});

describe('generateTextFaqPreview', () => {
  it('既存FAQを踏まえて重複判定付きのプレビューを返す', async () => {
    const db = makeMockPool(
      jest.fn().mockResolvedValue({ rows: [{ question: '営業時間を教えてください', answer: '9-18時' }] }),
    );
    mockGroqCall.mockResolvedValue('[{"question":"営業時間は","answer":"9-18時です","category":"store_info"}]');

    const preview = await generateTextFaqPreview(db, 't1', '十分な長さのテキスト。'.repeat(10));
    expect(preview).toHaveLength(1);
    expect(preview[0]!.duplicate).not.toBeNull();
  });
});

describe('generateScrapeFaqPreview / scrapeUrlToFaqs', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('HTMLからテキストを抽出しFAQプレビューを生成する', async () => {
    const db = makeMockPool(jest.fn().mockResolvedValue({ rows: [] }));
    const bodyText = 'この商品の詳細説明文です。'.repeat(10);
    global.fetch = jest.fn().mockResolvedValue({
      text: () => Promise.resolve(`<html><body>${bodyText}</body></html>`),
    }) as unknown as typeof fetch;
    mockGroqCall.mockResolvedValue('[{"question":"Q1","answer":"A1","category":"general"}]');

    const results = await generateScrapeFaqPreview(db, 't1', ['https://example.com/p/1']);
    expect(results).toHaveLength(1);
    expect(results[0]!.url).toBe('https://example.com/p/1');
    expect(results[0]!.faqs).toHaveLength(1);
    expect(results[0]!.error).toBeUndefined();
  });

  it('本文が50字未満ならerrorを返しGroqは呼ばない', async () => {
    const db = makeMockPool(jest.fn().mockResolvedValue({ rows: [] }));
    global.fetch = jest.fn().mockResolvedValue({
      text: () => Promise.resolve('<html><body>短い</body></html>'),
    }) as unknown as typeof fetch;

    const results = await generateScrapeFaqPreview(db, 't1', ['https://example.com/p/short']);
    expect(results[0]!.error).toBe('ページからテキストを取得できませんでした');
    expect(results[0]!.faqs).toEqual([]);
    expect(mockGroqCall).not.toHaveBeenCalled();
  });

  it('fetch失敗時は例外を投げずerrorフィールドに格納する', async () => {
    const db = makeMockPool(jest.fn().mockResolvedValue({ rows: [] }));
    global.fetch = jest.fn().mockRejectedValue(new Error('network error')) as unknown as typeof fetch;

    const results = await generateScrapeFaqPreview(db, 't1', ['https://example.com/p/fail']);
    expect(results[0]!.error).toContain('network error');
    expect(results[0]!.faqs).toEqual([]);
  });
});

describe('insertEmbeddingAsync', () => {
  it('embedText成功時にfaq_embeddingsへINSERTする（fire-and-forget）', async () => {
    const queryMock = jest.fn().mockResolvedValue({ rows: [] });
    const db = makeMockPool(queryMock);
    insertEmbeddingAsync(db, 't1', 'Q\nA', 42, { source: 'test', faq_id: 42 });
    // fire-and-forgetなのでマイクロタスクの完了を待つ
    await new Promise((r) => setImmediate(r));
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO faq_embeddings'),
      expect.arrayContaining(['t1', 'enc(Q\nA)']),
    );
  });
});

describe('commitTextFaqs', () => {
  it('新規FAQを登録しinsertedを返す', async () => {
    const queryMock = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // fetchExistingQuestions
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }); // INSERT ... RETURNING id
    const db = makeMockPool(queryMock);

    const result = await commitTextFaqs(
      db,
      't1',
      [{ question: 'Q1', answer: 'A1', category: 'general' }],
      undefined,
      'text',
    );
    expect(result).toEqual({ inserted: 1, skipped: 0, insertedIds: [1] });
  });

  it('既存FAQと類似する質問はスキップされる', async () => {
    const queryMock = jest.fn().mockResolvedValueOnce({ rows: [{ question: '営業時間を教えてください' }] });
    const db = makeMockPool(queryMock);

    const result = await commitTextFaqs(
      db,
      't1',
      [{ question: '営業時間は', answer: '9-18時です' }],
      undefined,
      'text',
    );
    expect(result).toEqual({ inserted: 0, skipped: 1, insertedIds: [] });
    // 重複スキップされたのでINSERTは呼ばれない（既存質問取得の1回のみ）
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('categoryOverrideが指定されればfaq個別のcategoryより優先される', async () => {
    const queryMock = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const db = makeMockPool(queryMock);

    await commitTextFaqs(db, 't1', [{ question: 'Q1', answer: 'A1', category: 'general' }], 'pricing', 'text');
    const insertCall = queryMock.mock.calls[1];
    expect(insertCall[1]).toEqual(['t1', 'Q1', 'A1', 'pricing']);
  });

  // オンボ 是正C-1: isPublishedパラメータは撤去した(唯一の呼び出し元だったOnboardingModalを
  // 削除したため)。登録は常に即公開(is_published=true固定)であることをSQL文字列で固定する。
  it('登録は常に即公開(is_published=true固定)で行われる', async () => {
    const queryMock = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const db = makeMockPool(queryMock);

    await commitTextFaqs(db, 't1', [{ question: 'Q1', answer: 'A1' }], undefined, 'text');
    const insertCall = queryMock.mock.calls[1];
    expect(insertCall[1]).toEqual(['t1', 'Q1', 'A1', 'general']);
    expect(String(insertCall[0])).toContain('VALUES ($1, $2, $3, $4, true)');
  });
});

describe('commitScrapeFaqs', () => {
  it('URL由来のFAQをtags・商品メタ付きで登録する', async () => {
    const queryMock = jest
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // fetchExistingQuestions
      .mockResolvedValueOnce({ rows: [{ id: 5 }] }); // INSERT ... RETURNING id
    const db = makeMockPool(queryMock);

    const result = await commitScrapeFaqs(
      db,
      't1',
      [
        {
          url: 'https://example.com/p/1',
          faqs: [{ question: 'Q1', answer: 'A1' }],
          productMeta: { product_image_url: 'https://cdn.example.com/i.jpg', product_price: '1000', product_cta_url: null },
        },
      ],
      undefined,
      'scrape',
    );
    expect(result).toEqual({ inserted: 1, skipped: 0, insertedIds: [5] });
    const insertCall = queryMock.mock.calls[1];
    expect(insertCall[1]).toEqual([
      't1',
      'Q1',
      'A1',
      'general',
      ['https://example.com/p/1'],
      'https://cdn.example.com/i.jpg',
      '1000',
      null,
    ]);
  });
});
