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
