// src/api/admin/knowledge/knowledgeRoutesAuthGuard.test.ts
// Phase69-1.5 PR-C4 v2 — knowledge/routes.ts requireKnowledgeRole guard tests

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

const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('../../../lib/db', () => ({
  pool: { query: mockQuery },
  getPool: () => ({ query: mockQuery }),
}));

jest.mock('../../../agent/llm/groqClient', () => ({
  groqClient: { call: jest.fn().mockResolvedValue('[]') },
}));
jest.mock('../../../agent/llm/openaiEmbeddingClient', () => ({
  embedText: jest.fn().mockResolvedValue([0]),
}));
jest.mock('./faqCrudRoutes', () => ({
  registerFaqCrudRoutes: jest.fn(),
}));
jest.mock('./bookPdfRoutes', () => ({
  registerBookPdfRoutes: jest.fn(),
}));
jest.mock('../../../lib/crypto/textEncrypt', () => ({
  encryptText: (s: string) => s,
}));

import express from 'express';
import request from 'supertest';
import { logger } from '../../../lib/logger';
import { registerKnowledgeAdminRoutes } from './routes';

const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];

beforeAll(() => {
  process.env['NODE_ENV'] = 'development';
});
afterAll(() => {
  process.env['NODE_ENV'] = ORIGINAL_NODE_ENV;
});
beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

function makeApp(decoded: Record<string, unknown> | null) {
  mockDecode.mockReturnValue(decoded);
  const app = express();
  app.use(express.json());
  registerKnowledgeAdminRoutes(app);
  return app;
}

const PATH = '/v1/admin/knowledge?tenant=t1';

describe('knowledge — requireKnowledgeRole guard', () => {
  it('viewer → 403 AUTHZ_ROLE_DENIED', async () => {
    const app = makeApp({ app_metadata: { role: 'viewer', tenant_id: 't1' }, email: 't@t.com' });
    const res = await request(app).get(PATH).set('Authorization', 'Bearer fake');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
    expect(logger.warn).toHaveBeenCalled();
  });
  it('stale JWT (user_metadata.role only) → 403 (app_metadata.role missing)', async () => {
    const app = makeApp({ user_metadata: { role: 'super_admin' }, email: 't@t.com' });
    const res = await request(app).get(PATH).set('Authorization', 'Bearer fake');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTHZ_ROLE_DENIED');
  });
  it('no app_metadata, top-level role → 403', async () => {
    const app = makeApp({ role: 'super_admin', email: 't@t.com' });
    const res = await request(app).get(PATH).set('Authorization', 'Bearer fake');
    expect(res.status).toBe(403);
  });
  it('null decode → 403 anonymous', async () => {
    const app = makeApp(null);
    const res = await request(app).get(PATH).set('Authorization', 'Bearer fake');
    expect(res.status).toBe(403);
  });
  it('super_admin → not 403', async () => {
    const app = makeApp({ app_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' });
    const res = await request(app).get(PATH).set('Authorization', 'Bearer fake');
    expect(res.status).not.toBe(403);
  });
  it('client_admin → not 403', async () => {
    const app = makeApp({ app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 't@t.com' });
    const res = await request(app).get(PATH).set('Authorization', 'Bearer fake');
    expect(res.status).not.toBe(403);
  });
});

// Phase73 — safeHttpUrl スキーム検証: POST /v1/admin/knowledge/scrape
describe('scrape — product URL scheme guard (safeHttpUrl)', () => {
  const SCRAPE_PATH = '/v1/admin/knowledge/scrape?tenant=t1';
  const adminDecoded = { app_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 't@t.com' };

  function makeScrapeApp(html: string) {
    const app = makeApp(adminDecoded);
    // global fetch を mock: 指定 HTML を返す
    global.fetch = jest.fn().mockResolvedValue({
      text: () => Promise.resolve(html),
      ok: true,
    } as unknown as Response);
    return app;
  }

  afterEach(() => {
    // global.fetch を元に戻す
    delete (global as Record<string, unknown>)['fetch'];
  });

  // body テキストは HTML タグ除去後に 50 文字以上必要（routes.ts の text.length < 50 チェック回避）
  const BODY_PADDING = 'この商品の詳細説明文です。商品情報をここに記載しています。テキストを十分な長さにするためのパディング文章。';

  it('javascript: スキームの og:url → product_cta_url が null', async () => {
    const html = `<html><head>
      <meta property="og:url" content="javascript:alert(1)" />
      <meta property="og:image" content="javascript:xss()" />
    </head><body>${BODY_PADDING}</body></html>`;
    const app = makeScrapeApp(html);
    const res = await request(app)
      .post(SCRAPE_PATH)
      .set('Authorization', 'Bearer fake')
      .send({ urls: ['https://example.com/p/danger'] });
    expect(res.status).toBe(200);
    const preview = res.body.preview as Array<{ productMeta?: { product_cta_url: string | null; product_image_url: string | null } }>;
    expect(preview[0]?.productMeta?.product_cta_url).toBeNull();
    expect(preview[0]?.productMeta?.product_image_url).toBeNull();
  });

  it('https: スキームの og:url → product_cta_url にそのまま採用される', async () => {
    const html = `<html><head>
      <meta property="og:url" content="https://example.com/p/1" />
      <meta property="og:image" content="https://cdn.example.com/img.jpg" />
    </head><body>${BODY_PADDING}</body></html>`;
    const app = makeScrapeApp(html);
    const res = await request(app)
      .post(SCRAPE_PATH)
      .set('Authorization', 'Bearer fake')
      .send({ urls: ['https://example.com/p/1'] });
    expect(res.status).toBe(200);
    const preview = res.body.preview as Array<{ productMeta?: { product_cta_url: string | null; product_image_url: string | null } }>;
    expect(preview[0]?.productMeta?.product_cta_url).toBe('https://example.com/p/1');
    expect(preview[0]?.productMeta?.product_image_url).toBe('https://cdn.example.com/img.jpg');
  });

  it('data: スキームの og:image → product_image_url が null、pageUrl フォールバックの cta_url は http(s) なら保持', async () => {
    const html = `<html><head>
      <meta property="og:image" content="data:image/png;base64,abc" />
    </head><body>${BODY_PADDING}</body></html>`;
    const app = makeScrapeApp(html);
    const res = await request(app)
      .post(SCRAPE_PATH)
      .set('Authorization', 'Bearer fake')
      .send({ urls: ['https://example.com/p/safe'] });
    expect(res.status).toBe(200);
    const preview = res.body.preview as Array<{ productMeta?: { product_cta_url: string | null; product_image_url: string | null } }>;
    expect(preview[0]?.productMeta?.product_image_url).toBeNull();
    // og:url なし → pageUrl('https://example.com/p/safe') にフォールバック → http(s) なので保持
    expect(preview[0]?.productMeta?.product_cta_url).toBe('https://example.com/p/safe');
  });
});
