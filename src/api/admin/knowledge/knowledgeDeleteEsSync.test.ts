// src/api/admin/knowledge/knowledgeDeleteEsSync.test.ts
//
// ナレッジ配線是正 P4 (Asana GID 1217811043876236):
// DELETE /v1/admin/knowledge/:id は faq_docs.es_doc_id 列(常にNULLで一度も埋まらない
// 死列)を読んでESドキュメント削除のガードにしていたため、ESドキュメント削除が
// 一度も実行されていなかった。削除したはずのFAQが BM25 経由で回答に出続ける欠陥。
//
// 修正: es_doc_id への依存をやめ、faqIndexSync.ts の deleteFaqFromEs(tenantId, faqId)
// (doc id を faqEsDocId 規約から決定的に導出)を無条件で呼ぶ。
// .claude/rules/knowledge.md 参照。

jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockDecode = jest.fn();
jest.mock('jsonwebtoken', () => ({
  __esModule: true,
  default: {
    decode: (...args: unknown[]) => mockDecode(...args),
    verify: jest.fn(),
    sign: jest.fn(),
  },
  decode: (...args: unknown[]) => mockDecode(...args),
  verify: jest.fn(),
  sign: jest.fn(),
}));

const mockQuery = jest.fn();
jest.mock('../../../lib/db', () => ({
  pool: { query: mockQuery },
  getPool: () => ({ query: mockQuery }),
}));

jest.mock('./faqCrudRoutes', () => ({ registerFaqCrudRoutes: jest.fn() }));
jest.mock('./bookPdfRoutes', () => ({ registerBookPdfRoutes: jest.fn() }));
jest.mock('../../../agent/llm/openaiEmbeddingClient', () => ({
  embedText: jest.fn().mockResolvedValue([0]),
}));
jest.mock('../../../lib/crypto/textEncrypt', () => ({ encryptText: (s: string) => s }));

import express from 'express';
import request from 'supertest';
import { registerKnowledgeAdminRoutes } from './routes';
import { resolveFaqWriteIndex } from '../../../search/langIndex';
import { faqEsDocId } from '../../../lib/knowledge/faqIndexSync';

const TENANT = 't1';
const ES_URL = 'http://es.test:9200';

type Captured = { url: string; method: string };
let captured: Captured[] = [];
const originalFetch = global.fetch;

function installFetchSpy() {
  global.fetch = jest.fn(async (input: unknown, init?: { method?: string }) => {
    captured.push({ url: String(input), method: init?.method ?? 'GET' });
    return { ok: true, status: 200, text: async () => '', json: async () => ({}) } as unknown as Response;
  }) as unknown as typeof fetch;
}

function makeApp(decoded: Record<string, unknown> | null) {
  mockDecode.mockReturnValue(decoded);
  const app = express();
  app.use(express.json());
  registerKnowledgeAdminRoutes(app);
  return app;
}

const ADMIN_DECODED = { app_metadata: { role: 'super_admin', tenant_id: TENANT }, email: 't@t.com' };

const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];
beforeAll(() => {
  process.env['NODE_ENV'] = 'development';
});
afterAll(() => {
  process.env['NODE_ENV'] = ORIGINAL_NODE_ENV;
});

beforeEach(() => {
  jest.clearAllMocks();
  captured = [];
  installFetchSpy();
  process.env['ES_URL'] = ES_URL;
});

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env['ES_URL'];
});

describe('DELETE /v1/admin/knowledge/:id — ES同期', () => {
  it('削除成功時、faqEsDocId規約のURLへ ES DELETE が送られる(es_doc_idに依存しない)', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT id, tenant_id FROM faq_docs/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 42, tenant_id: TENANT }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const app = makeApp(ADMIN_DECODED);

    const res = await request(app)
      .delete(`/v1/admin/knowledge/42?tenant=${TENANT}`)
      .set('Authorization', 'Bearer fake');

    expect(res.status).toBe(200);

    const esDeletes = captured.filter((c) => c.method === 'DELETE');
    expect(esDeletes).toHaveLength(1);
    const expectedIndex = resolveFaqWriteIndex(TENANT);
    const expectedDocId = faqEsDocId(TENANT, 42);
    expect(esDeletes[0]!.url).toContain(`/${expectedIndex}/_doc/${expectedDocId}`);
  });

  it('チェッククエリが es_doc_id 列を参照しない', async () => {
    mockQuery.mockImplementation((sql: string) => {
      expect(sql).not.toContain('es_doc_id');
      if (/SELECT id, tenant_id FROM faq_docs/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 1, tenant_id: TENANT }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const app = makeApp(ADMIN_DECODED);

    await request(app).delete(`/v1/admin/knowledge/1?tenant=${TENANT}`).set('Authorization', 'Bearer fake');

    expect(mockQuery).toHaveBeenCalled();
  });

  it('対象が見つからない場合は404で、ES削除は呼ばれない', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const app = makeApp(ADMIN_DECODED);

    const res = await request(app)
      .delete(`/v1/admin/knowledge/999?tenant=${TENANT}`)
      .set('Authorization', 'Bearer fake');

    expect(res.status).toBe(404);
    expect(captured.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  });
});
