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
  groqClient: {
    call: jest.fn().mockResolvedValue('[]'),
    // PR-1(2026-08-25収益監査): textToFaqs は callWithUsage に差し替え済み。
    callWithUsage: jest.fn().mockResolvedValue({ content: '[]', usage: { prompt_tokens: 0, completion_tokens: 0 } }),
  },
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
import { request } from "../../../../tests/helpers/testServer";
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

// Phase82 A2 — text/commit・scrape/commit の body.target 越境write遮断
describe('knowledge commit — target による越境write遮断', () => {
  const clientAdminT1 = { app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 't@t.com' };
  const superAdmin = { app_metadata: { role: 'super_admin', tenant_id: null }, email: 'sa@t.com' };

  const faq = { question: 'Q', answer: 'A' };

  it('POST /text/commit: client_admin が target=他テナントを指定 → 403、自テナントには書き込まれない', async () => {
    const app = makeApp(clientAdminT1);
    const res = await request(app)
      .post('/v1/admin/knowledge/text/commit?tenant=t1')
      .set('Authorization', 'Bearer fake')
      .send({ faqs: [faq], target: 'tenantB' });
    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO faq_docs'), expect.anything());
  });

  it('POST /text/commit: client_admin が target 省略（自テナント） → 201', async () => {
    const app = makeApp(clientAdminT1);
    const res = await request(app)
      .post('/v1/admin/knowledge/text/commit?tenant=t1')
      .set('Authorization', 'Bearer fake')
      .send({ faqs: [faq] });
    expect(res.status).toBe(201);
  });

  it('POST /text/commit: super_admin は target=他テナントを指定でき、そのテナントに書き込まれる', async () => {
    const app = makeApp(superAdmin);
    const res = await request(app)
      .post('/v1/admin/knowledge/text/commit?tenant=t1')
      .set('Authorization', 'Bearer fake')
      .send({ faqs: [faq], target: 'tenantB' });
    expect(res.status).toBe(201);
    const insertCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO faq_docs')
    );
    expect(insertCall?.[1]?.[0]).toBe('tenantB');
  });

  it('POST /scrape/commit: client_admin が target=他テナントを指定 → 403', async () => {
    const app = makeApp(clientAdminT1);
    const res = await request(app)
      .post('/v1/admin/knowledge/scrape/commit?tenant=t1')
      .set('Authorization', 'Bearer fake')
      .send({ items: [{ url: 'https://example.com/p/1', faqs: [faq] }], target: 'tenantB' });
    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO faq_docs'), expect.anything());
  });

  it('GET /structurize-status: client_admin が ?tenant=他テナントを指定 → 403（requireKnowledgeTenant）', async () => {
    const app = makeApp(clientAdminT1);
    const res = await request(app)
      .get('/v1/admin/knowledge/structurize-status?tenant=tenantB')
      .set('Authorization', 'Bearer fake');
    expect(res.status).toBe(403);
  });

  // --- 壊れやすいポイント: target の境界値・イレギュラー値 ---

  it('POST /text/commit: client_admin が target=自テナントを明示指定 → 201（許可されるべき）', async () => {
    const app = makeApp(clientAdminT1);
    const res = await request(app)
      .post('/v1/admin/knowledge/text/commit?tenant=t1')
      .set('Authorization', 'Bearer fake')
      .send({ faqs: [faq], target: 't1' });
    expect(res.status).toBe(201);
  });

  it('POST /text/commit: client_admin が target="" (空文字列) → falsyフォールバックで自テナントに書き込まれる（201）', async () => {
    const app = makeApp(clientAdminT1);
    const res = await request(app)
      .post('/v1/admin/knowledge/text/commit?tenant=t1')
      .set('Authorization', 'Bearer fake')
      .send({ faqs: [faq], target: '' });
    expect(res.status).toBe(201);
    const insertCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO faq_docs')
    );
    // target="" は `rawTarget || tenantId` で自テナント(t1)にフォールバックする設計。
    // 空文字列が「意図しないテナント」として素通りしないことを固定する。
    expect(insertCall?.[1]?.[0]).toBe('t1');
  });

  it('POST /text/commit: client_admin が target="global" → 403（他テナント越境ガードにも一致し二重に防がれる）', async () => {
    const app = makeApp(clientAdminT1);
    const res = await request(app)
      .post('/v1/admin/knowledge/text/commit?tenant=t1')
      .set('Authorization', 'Bearer fake')
      .send({ faqs: [faq], target: 'global' });
    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO faq_docs'), expect.anything());
  });

  it('POST /text/commit: client_admin が自テナントIDの大文字小文字違い(target="T1")を指定 → 403（大小区別する厳密一致）', async () => {
    const app = makeApp(clientAdminT1);
    const res = await request(app)
      .post('/v1/admin/knowledge/text/commit?tenant=t1')
      .set('Authorization', 'Bearer fake')
      .send({ faqs: [faq], target: 'T1' });
    // target !== tenantId は厳密文字列比較のため、大小文字違いは「別テナント」として拒否される。
    // 大小無視の緩い一致に変わっていないことを固定する。
    expect(res.status).toBe(403);
  });

  it('POST /text/commit: client_admin が target に長大・特殊文字列（SQLインジェクション様）を指定 → 403、DBに到達しない', async () => {
    const app = makeApp(clientAdminT1);
    const malicious = "tenantB'; DROP TABLE faq_docs; --" + 'x'.repeat(500);
    const res = await request(app)
      .post('/v1/admin/knowledge/text/commit?tenant=t1')
      .set('Authorization', 'Bearer fake')
      .send({ faqs: [faq], target: malicious });
    expect(res.status).toBe(403);
    // 越境ガードが文字列比較のみで弾くため、悪意ある値がSQLクエリの引数として
    // DBレイヤーに到達しないことを確認する（防御は認可層で完結する）。
    expect(mockQuery).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO faq_docs'), expect.anything());
  });

  it('POST /text/commit: super_admin が target 省略 → tenant クエリパラメータ(自身が指定したテナント)に書き込まれる', async () => {
    const app = makeApp(superAdmin);
    const res = await request(app)
      .post('/v1/admin/knowledge/text/commit?tenant=t1')
      .set('Authorization', 'Bearer fake')
      .send({ faqs: [faq] });
    expect(res.status).toBe(201);
    const insertCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO faq_docs')
    );
    // target未指定時のsuper_adminの既定挙動: `?tenant=`クエリの値にフォールバックする
    // （bodyのtargetを省略しても無認可の書き込み先にならないことを固定）。
    expect(insertCall?.[1]?.[0]).toBe('t1');
  });

  it('POST /scrape/commit: client_admin が target="" (空文字列) → 自テナントにフォールバックし成功する', async () => {
    const app = makeApp(clientAdminT1);
    const res = await request(app)
      .post('/v1/admin/knowledge/scrape/commit?tenant=t1')
      .set('Authorization', 'Bearer fake')
      .send({ items: [{ url: 'https://example.com/p/1', faqs: [faq] }], target: '' });
    expect(res.status).not.toBe(403);
  });

  it('POST /scrape/commit: super_admin が target=他テナントを指定 → そのテナントに書き込まれる（text/commitと同じ判断基準）', async () => {
    const app = makeApp(superAdmin);
    const res = await request(app)
      .post('/v1/admin/knowledge/scrape/commit?tenant=t1')
      .set('Authorization', 'Bearer fake')
      .send({ items: [{ url: 'https://example.com/p/1', faqs: [faq] }], target: 'tenantB' });
    expect(res.status).toBe(201);
    const insertCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO faq_docs')
    );
    expect(insertCall?.[1]?.[0]).toBe('tenantB');
  });
});
