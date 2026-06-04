// src/agent/knowledge/bookStructurizer.test.ts
// F3 / Phase69-2-E: 書籍 ES write path の index 名がテナント別 `faq_${tenantId}` であることを保証する。
//
// 背景: bookStructurizer は Phase69-2-E の write/read index 統一から漏れており、
// 旧実装はモジュールレベルの `process.env['ES_FAQ_INDEX'] ?? 'faqs'` を使っていた。
// read path（resolveFallbackIndices の `faq_${tenantId}`）と不整合なため、書籍由来 doc が
// 検索 index に届かない（= book pipeline が無言で検索に反映されない）バグだった。
// 本テストは upsert 先 index が resolveFaqWriteIndex と一致し、ES_FAQ_INDEX を無視することを保証する。

import { upsertToEs } from './bookStructurizer';
import { resolveFaqWriteIndex } from '../../search/langIndex';

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
