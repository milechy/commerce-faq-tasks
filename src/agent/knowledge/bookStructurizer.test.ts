// src/agent/knowledge/bookStructurizer.test.ts
// F3 / Phase69-2-E: 書籍 ES write path の index 名がテナント別 `faq_${tenantId}` であることを保証する。
//
// 背景: bookStructurizer は Phase69-2-E の write/read index 統一から漏れており、
// 旧実装はモジュールレベルの `process.env['ES_FAQ_INDEX'] ?? 'faqs'` を使っていた。
// read path（resolveFallbackIndices の `faq_${tenantId}`）と不整合なため、書籍由来 doc が
// 検索 index に届かない（= book pipeline が無言で検索に反映されない）バグだった。
// 本テストは upsert 先 index が resolveFaqWriteIndex と一致し、ES_FAQ_INDEX を無視することを保証する。

import { upsertToEs, structurizeBook, buildSearchText } from './bookStructurizer';
import { resolveFaqWriteIndex } from '../../search/langIndex';
import { callGeminiJudge } from '../../lib/gemini/client';
import { getPool } from '../../lib/db';
import { embedText } from '../llm/openaiEmbeddingClient';
import { buildSearchTextFields } from '../psychology/principleSchemaMap';

jest.mock('../../lib/gemini/client', () => ({ callGeminiJudge: jest.fn() }));
jest.mock('../../lib/db', () => ({ getPool: jest.fn() }));
jest.mock('../llm/openaiEmbeddingClient', () => ({ embedText: jest.fn() }));

describe('bookStructurizer upsertToEs — ES write index 統一 (F3 / Phase69-2-E)', () => {
  const ORIG_ES_URL = process.env.ES_URL;
  const ORIG_ES_FAQ_INDEX = process.env.ES_FAQ_INDEX;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env.ES_URL = 'http://es.local:9200';
  });

  afterEach(() => {
    if (ORIG_ES_URL !== undefined) process.env.ES_URL = ORIG_ES_URL;
    else delete process.env.ES_URL;
    if (ORIG_ES_FAQ_INDEX !== undefined) process.env.ES_FAQ_INDEX = ORIG_ES_FAQ_INDEX;
    else delete process.env.ES_FAQ_INDEX;
    jest.restoreAllMocks();
  });

  it('書き込み先 index は faq_${tenantId}（read path と統一）', async () => {
    await upsertToEs('carnation', 'book_1_chunk_0_x', { tenant_id: 'carnation' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe(
      `http://es.local:9200/${resolveFaqWriteIndex('carnation')}/_doc/book_1_chunk_0_x`,
    );
    expect(url).toContain('/faq_carnation/_doc/');
  });

  it('ES_FAQ_INDEX が設定されていても無視する（廃止済み）', async () => {
    process.env.ES_FAQ_INDEX = 'should_be_ignored';
    await upsertToEs('demo', 'doc1', {});
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/faq_demo/_doc/');
    expect(url).not.toContain('should_be_ignored');
    expect(url).not.toContain('/faqs/_doc/');
  });

  it('テナントごとに別 index へ書く（テナント分離）', async () => {
    await upsertToEs('t1', 'd', {});
    await upsertToEs('t2', 'd', {});
    expect(fetchMock.mock.calls[0]![0]).toContain('/faq_t1/_doc/');
    expect(fetchMock.mock.calls[1]![0]).toContain('/faq_t2/_doc/');
  });

  it('ES_URL 未設定なら fetch しない（best-effort、パイプラインを止めない）', async () => {
    delete process.env.ES_URL;
    await upsertToEs('demo', 'd', {});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// 2026-08-29 継ぎ目バグ回帰テスト:
// principleSearch.ts が読む metadata の形と、structurizeBook が実際に書く形が
// 一致することを、Gemini/DB/埋め込みをモックしたうえで structurizeBook 本体を
// 実行して検証する(principleContract.test.ts はソース走査、こちらは実行結果の検証)。
describe('bookStructurizer structurizeBook — metadata の継ぎ目 (2026-08-29)', () => {
  const ORIG_ENABLED = process.env.BOOK_STRUCTURIZE_ENABLED;
  let queryMock: jest.Mock;

  beforeEach(() => {
    process.env.BOOK_STRUCTURIZE_ENABLED = 'true';
    queryMock = jest.fn().mockResolvedValue({ rows: [{ id: 1 }] });
    (getPool as jest.Mock).mockReturnValue({ query: queryMock });
    (embedText as jest.Mock).mockResolvedValue([0.1, 0.2, 0.3]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (ORIG_ENABLED !== undefined) process.env.BOOK_STRUCTURIZE_ENABLED = ORIG_ENABLED;
    else delete process.env.BOOK_STRUCTURIZE_ENABLED;
    jest.restoreAllMocks();
  });

  /** faq_embeddings への INSERT が呼ばれた際の第4引数(metadata JSON)を取り出す。 */
  function insertedMetadata(): Record<string, unknown> {
    const call = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO faq_embeddings'));
    expect(call).toBeDefined();
    return JSON.parse(call![1][3] as string);
  }

  it('保存する metadata に example と page_number を含む(example欠落・page_hint不一致の回帰)', async () => {
    (callGeminiJudge as jest.Mock).mockResolvedValue(JSON.stringify([
      {
        situation: '価格提示の前に基準値を示す',
        resistance: '価格が高いと感じている',
        principle: 'アンカリング効果',
        contraindication: '誇大広告は禁止',
        example: '通常価格を先に見せる',
        failure_example: '過大なアンカーは不信感を招く',
      },
    ]));

    await structurizeBook('carnation', 1, '価格交渉に関する短いテキスト。');

    const metadata = insertedMetadata();
    expect(metadata.example).toBe('通常価格を先に見せる');
    expect(metadata.page_number).toBeDefined();
    expect(metadata).not.toHaveProperty('page_hint');
  });

  it('principleVocabulary.ts に無い原則名は保存せず skippedCount に計上する', async () => {
    (callGeminiJudge as jest.Mock).mockResolvedValue(JSON.stringify([
      {
        situation: '状況',
        resistance: '抵抗',
        principle: '返報性の原理', // 語彙には「返報性」しか無い表記揺れ
        contraindication: '注意',
        example: '例文',
        failure_example: '失敗例',
      },
    ]));

    const result = await structurizeBook('carnation', 1, '短いテキスト。');

    expect(result.structuredCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(queryMock).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO faq_embeddings'),
      expect.anything(),
    );
  });

  it('語彙に一致する原則名は通常どおり保存される', async () => {
    (callGeminiJudge as jest.Mock).mockResolvedValue(JSON.stringify([
      {
        situation: '状況',
        resistance: '抵抗',
        principle: '希少性',
        contraindication: '注意',
        example: '例文',
        failure_example: '失敗例',
      },
    ]));

    const result = await structurizeBook('carnation', 1, '短いテキスト。');

    expect(result.structuredCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(insertedMetadata().principle).toBe('希少性');
  });
});

// T5: buildSearchText をスキーマ非依存にするリファクタ。
// 経路2(structurizeBook)の出力は変えず、T6(チャンク編集の再埋め込み)で
// psychology_book / sales_manual 双方に使えることを検証する。
describe('buildSearchText — スキーマ非依存化 (T5)', () => {
  it('ラベル付きフィールドを【label】value の形で連結する', () => {
    const text = buildSearchText([
      { label: '原則', value: 'アンカリング効果' },
      { label: '状況', value: '価格提示の前' },
    ]);
    expect(text).toBe('【原則】アンカリング効果\n【状況】価格提示の前');
  });

  it('800字を超える場合は切り詰める', () => {
    const text = buildSearchText([{ label: '原則', value: 'あ'.repeat(900) }]);
    expect(text.length).toBe(800);
  });

  it('psychology_book スキーマの metadata から妥当な検索テキストが組み立つ', () => {
    const fields = buildSearchTextFields('psychology_book', {
      principle: 'アンカリング効果',
      situation: '価格提示の前に基準値を示す',
      example: '通常価格を先に見せる',
      contraindication: '誇大広告は禁止',
    });
    const text = buildSearchText(fields);
    expect(text).toContain('アンカリング効果');
    expect(text).toContain('価格提示の前に基準値を示す');
    expect(text).toContain('通常価格を先に見せる');
    expect(text).toContain('誇大広告は禁止');
  });

  it('sales_manual スキーマの metadata から妥当な検索テキストが組み立つ(problem/solution/objection_handling)', () => {
    const fields = buildSearchTextFields('sales_manual', {
      target_customer: '中小企業の経営者',
      problem: '商談の主導権をお客さまに握られてしまう',
      solution: '営業マンがプロフェッショナルとして知識を提供し、お客さまを助ける',
      benefit: '営業マンが売れる',
      objection_handling: '価格が高いと言われたら価値を再説明する',
    });
    const text = buildSearchText(fields);
    expect(text).toContain('商談の主導権をお客さまに握られてしまう');
    expect(text).toContain('営業マンがプロフェッショナルとして知識を提供し、お客さまを助ける');
    expect(text).toContain('価格が高いと言われたら価値を再説明する');
    // benefit / target_customer は principleSchemaMap.ts の対応表で意図的に未使用
    expect(text).not.toContain('営業マンが売れる');
    expect(text).not.toContain('中小企業の経営者');
  });

  it('対応表に無いスキーマ(product_catalog等)は空配列になる', () => {
    const fields = buildSearchTextFields('product_catalog', {
      product_name: '商品A',
      spec: '仕様',
    });
    expect(fields).toEqual([]);
    expect(buildSearchText(fields)).toBe('');
  });
});
