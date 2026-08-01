// src/api/admin/avatar/avatarGenerationAuthGuard.test.ts
// GID1215114475058706: avatar generation 3ルート認可ガードテスト
// 既存の avatarAuthGuard.test.ts (routes.ts向け) には一切触れない

jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));
jest.mock('../../../auth/supabaseClient', () => ({
  supabaseAdmin: null,
}));
jest.mock('../../../lib/billing/usageTracker', () => ({
  trackUsage: jest.fn(),
}));
jest.mock('../../../lib/contentGuard', () => ({
  containsBannedWord: jest.fn().mockReturnValue(false),
}));
jest.mock('../../../lib/magnific', () => ({
  upscaleWithMagnific: jest.fn().mockResolvedValue(null),
}));
// generate-premium(client_admin時)が queryTenantPlan 経由で参照する。
// DATABASE_URL 未設定の場合 getPool() が同期例外を投げるため、この describe
// ブロックで generate-premium を対象に含める(#P1-B)前提としてモックが必要。
// growthプラン固定で「テナントが解決できれば400にならない」検証に支障が出ないようにする。
jest.mock('../../../lib/db', () => ({
  getPool: () => ({ query: jest.fn().mockResolvedValue({ rows: [{ plan: 'growth' }] }) }),
}));

import express from 'express';
import request from 'supertest';
import { logger } from '../../../lib/logger';
import { registerAvatarGenerationRoutes } from './generationRoutes';
import { registerFalGenerationRoutes } from './falGenerationRoutes';
import { registerPremiumGenerationRoutes } from './premiumGenerationRoutes';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

function makeApp(user: Record<string, unknown> | null) {
  const fakeDb = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: jest.fn(),
    }),
  };
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = user;
    next();
  });
  registerAvatarGenerationRoutes(app, fakeDb);
  registerFalGenerationRoutes(app);
  registerPremiumGenerationRoutes(app);
  return app;
}

const GENERATION_ENDPOINTS = [
  { method: 'post' as const, path: '/v1/admin/avatar/generate-image',   body: { description: 'professional headshot' } },
  { method: 'post' as const, path: '/v1/admin/avatar/match-voice',      body: { description: 'calm professional voice' } },
  { method: 'post' as const, path: '/v1/admin/avatar/design-voice',     body: { instruction: '落ち着いた30代女性の声。ゆっくり丁寧に話す。' } },
  { method: 'post' as const, path: '/v1/admin/avatar/generate-prompt',  body: { rules: 'You are a helpful assistant. Be professional and friendly.' } },
  { method: 'post' as const, path: '/v1/admin/avatar/fal/generate',     body: { prompt: 'professional headshot portrait of a business person' } },
  { method: 'post' as const, path: '/v1/admin/avatar/generate-premium', body: { prompt: 'professional headshot portrait of a business person' } },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue({
    ok: false,
    status: 500,
    json: async () => ({}),
    text: async () => '',
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: { get: () => null },
  });
});

// ── fail-closed: 認可されないロール → 403 ─────────────────────────────────────

describe('avatar generation routes — fail-closed: unauthorized → 403', () => {
  GENERATION_ENDPOINTS.forEach(({ method, path, body }) => {
    it(`${method.toUpperCase()} ${path} — null user → 403`, async () => {
      const app = makeApp(null);
      const res = await (request(app) as any)[method](path).send(body);
      expect(res.status).toBe(403);
    });

    it(`${method.toUpperCase()} ${path} — viewer role → 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'viewer', tenant_id: 't1' }, email: 'v@t.com' });
      const res = await (request(app) as any)[method](path).send(body);
      expect(res.status).toBe(403);
    });

    it(`${method.toUpperCase()} ${path} — stale JWT (user_metadata only) → 403`, async () => {
      const app = makeApp({ user_metadata: { role: 'super_admin', tenant_id: 't1' }, email: 's@t.com' });
      const res = await (request(app) as any)[method](path).send(body);
      expect(res.status).toBe(403);
    });

    it(`${method.toUpperCase()} ${path} — anonymous role → 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'anonymous' }, email: 'anon@t.com' });
      const res = await (request(app) as any)[method](path).send(body);
      expect(res.status).toBe(403);
    });
  });
});

// ── observability: 認可拒否時にログが出る ────────────────────────────────────

describe('avatar generation routes — observability: logger.warn on denial', () => {
  GENERATION_ENDPOINTS.forEach(({ method, path, body }) => {
    it(`${method.toUpperCase()} ${path} — viewer denied → logger.warn called`, async () => {
      const app = makeApp({ app_metadata: { role: 'viewer', tenant_id: 't1' }, email: 'v@t.com' });
      await (request(app) as any)[method](path).send(body);
      expect(logger.warn).toHaveBeenCalled();
    });

    it(`${method.toUpperCase()} ${path} — null user denied → logger.warn called`, async () => {
      const app = makeApp(null);
      await (request(app) as any)[method](path).send(body);
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});

// ── allow-path: super_admin / client_admin は 403 にならない ─────────────────

describe('avatar generation routes — allow-path: super_admin passes authz', () => {
  GENERATION_ENDPOINTS.forEach(({ method, path, body }) => {
    it(`${method.toUpperCase()} ${path} — super_admin → not 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'super_admin' }, email: 'sa@t.com' });
      const res = await (request(app) as any)[method](path).send(body);
      expect(res.status).not.toBe(403);
    });
  });
});

describe('avatar generation routes — allow-path: client_admin passes authz', () => {
  GENERATION_ENDPOINTS.forEach(({ method, path, body }) => {
    it(`${method.toUpperCase()} ${path} — client_admin with tenant → not 403`, async () => {
      const app = makeApp({ app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 'ca@t.com' });
      const res = await (request(app) as any)[method](path).send(body);
      expect(res.status).not.toBe(403);
    });
  });
});

// ── fail-closed: client_admin with no tenant_id → 403 (roleAuthMiddleware early return) ──

describe('avatar generation routes — fail-closed: client_admin without tenant_id → 403', () => {
  GENERATION_ENDPOINTS.forEach(({ method, path, body }) => {
    it(`${method.toUpperCase()} ${path} — client_admin no tenant → 403`, async () => {
      // roleAuthMiddleware returns 403 early when client_admin has no tenant_id
      const app = makeApp({ app_metadata: { role: 'client_admin' }, email: 'ca-notenant@t.com' });
      const res = await (request(app) as any)[method](path).send(body);
      expect(res.status).toBe(403);
    });
  });
});

// ── テナント解決: super_adminが?tenant=を付けないと400(外部API未呼び出し) ──
// generate-premiumは#P0-1〜#P0-3では意図的にスコープ外だったが、#P1-Bで
// resolveEffectiveTenantId + 400ガードを導入したため、他4ルートと同じ
// テーブル駆動テストがそのまま適用できる。除外リストは無くなった。
const TENANT_GUARDED_ENDPOINTS = GENERATION_ENDPOINTS;

describe('avatar generation routes — テナント不明時は400、外部APIを呼ばない', () => {
  TENANT_GUARDED_ENDPOINTS.forEach(({ method, path, body }) => {
    it(`${method.toUpperCase()} ${path} — super_adminが?tenant=なし → 400、fetch未呼び出し`, async () => {
      const app = makeApp({ app_metadata: { role: 'super_admin' }, email: 'sa@t.com' });
      const res = await (request(app) as any)[method](path).send(body);
      expect(res.status).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    // 空白のみ／複数指定は、テナントとして採用してはいけないが 400 で
    // 落ちることまで確認しないと「truthy だから通った」に気づけない。
    it(`${method.toUpperCase()} ${path} — ?tenant=が空白のみ → 400、fetch未呼び出し`, async () => {
      const app = makeApp({ app_metadata: { role: 'super_admin' }, email: 'sa@t.com' });
      const res = await (request(app) as any)[method](`${path}?tenant=%20%20`).send(body);
      expect(res.status).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it(`${method.toUpperCase()} ${path} — ?tenant=を2回指定 → 400、fetch未呼び出し`, async () => {
      const app = makeApp({ app_metadata: { role: 'super_admin' }, email: 'sa@t.com' });
      const res = await (request(app) as any)[method](`${path}?tenant=t1&tenant=t2`).send(body);
      expect(res.status).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});

// ── 過剰ブロックしていないことの対検証 ────────────────────────────────────
// 上の 400 ガードだけを見ていると「常に400を返す」実装でもテストが通ってしまう。
// テナントが解決できるときは通ること（＝外部APIまで到達すること）を必ず対で押さえる。

describe('avatar generation routes — テナントが解決できれば400にならず外部APIへ到達する', () => {
  // 外部APIキーが無いと、テナントガードを通過しても手前で 500 になり fetch まで
  // 到達しない。「ガードを抜けて実処理に入った」ことを見たいので一式用意する
  // （応答自体は共通 beforeEach の失敗レスポンスのままでよい）。
  beforeEach(() => {
    process.env.GROQ_API_KEY = 'test-groq-key';
    process.env.LEONARDO_API_KEY = 'test-leonardo-key';
    process.env.FISH_AUDIO_API_KEY = 'test-fish-key';
    process.env.FAL_KEY = 'test-fal-key';
  });

  afterEach(() => {
    delete process.env.GROQ_API_KEY;
    delete process.env.LEONARDO_API_KEY;
    delete process.env.FISH_AUDIO_API_KEY;
    delete process.env.FAL_KEY;
  });

  TENANT_GUARDED_ENDPOINTS.forEach(({ method, path, body }) => {
    it(`${method.toUpperCase()} ${path} — super_admin + ?tenant=t1 → 400にならない`, async () => {
      const app = makeApp({ app_metadata: { role: 'super_admin' }, email: 'sa@t.com' });
      const res = await (request(app) as any)[method](`${path}?tenant=t1`).send(body);
      expect(res.status).not.toBe(400);
      expect(mockFetch).toHaveBeenCalled();
    });

    it(`${method.toUpperCase()} ${path} — client_admin(自テナントあり) → 400にならない`, async () => {
      const app = makeApp({ app_metadata: { role: 'client_admin', tenant_id: 't1' }, email: 'ca@t.com' });
      const res = await (request(app) as any)[method](path).send(body);
      expect(res.status).not.toBe(400);
      expect(mockFetch).toHaveBeenCalled();
    });
  });
});

// ── allow-path: 認可通過時にログが出ないこと ─────────────────────────────────

describe('avatar generation routes — allow-path: no authz warn on success', () => {
  GENERATION_ENDPOINTS.forEach(({ method, path, body }) => {
    it(`${method.toUpperCase()} ${path} — super_admin → logger.warn NOT called for authz denial`, async () => {
      const app = makeApp({ app_metadata: { role: 'super_admin' }, email: 'sa@t.com' });
      await (request(app) as any)[method](path).send(body);
      const warnCalls = (logger.warn as jest.Mock).mock.calls;
      const authzWarnCalled = warnCalls.some(
        (args) => typeof args[0] === 'object' && args[0]?.event?.includes('authz_denied')
      );
      expect(authzWarnCalled).toBe(false);
    });
  });
});
