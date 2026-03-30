// tests/phase48/apiKeyAuth.test.ts
// Bug-1: SHA-256 hashApiKey 一貫性テスト + Input Sanitizer 共存テスト

import * as crypto from 'node:crypto';
import { sanitizeInput, sessionHistoryStore } from '../../src/middleware/inputSanitizer';

// ---------------------------------------------------------------------------
// hashApiKey — 本番コードと同じロジックをここで直接テスト（関数はエクスポート外）
// ---------------------------------------------------------------------------

function hashApiKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

describe('hashApiKey consistency', () => {
  it('produces a 64-char hex string', () => {
    const hash = hashApiKey('test-api-key');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same input always produces the same hash', () => {
    const key = 'my-secret-api-key-12345';
    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  it('different inputs produce different hashes', () => {
    expect(hashApiKey('key-A')).not.toBe(hashApiKey('key-B'));
  });

  it('hash does not contain the original key value', () => {
    const key = 'sensitive-api-key-value';
    const hash = hashApiKey(key);
    expect(hash).not.toContain(key);
  });

  it('matches precomputed SHA-256 hex digest', () => {
    // Precomputed: echo -n "hello" | sha256sum
    const expected = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    expect(hashApiKey('hello')).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// authMiddleware integration — valid / invalid API key
// ---------------------------------------------------------------------------

import express from 'express';
import request from 'supertest';
import { initAuthMiddleware } from '../../src/agent/http/authMiddleware';
import type { TenantConfig } from '../../src/types/contracts';

function buildApp(resolveByApiKeyHash?: (hash: string) => TenantConfig | undefined) {
  const app = express();
  app.use(express.json());

  const auth = initAuthMiddleware({ resolveByApiKeyHash });

  app.get('/protected', auth as any, (req: any, res) => {
    res.json({ tenantId: req.tenantId });
  });

  return app;
}

describe('authMiddleware — API key authentication', () => {
  const RAW_KEY = 'test-raw-api-key-abc123';
  const KEY_HASH = hashApiKey(RAW_KEY);

  const makeTenantConfig = (tenantId: string, enabled: boolean): TenantConfig => ({
    tenantId,
    name: 'Test Tenant',
    plan: 'starter',
    features: { avatar: false, voice: false, rag: true },
    security: {
      apiKeyHash: KEY_HASH,
      hashAlgorithm: 'sha256',
      allowedOrigins: ['*'],
      rateLimit: 100,
      rateLimitWindowMs: 60000,
    },
    enabled,
  });

  const resolver = (hash: string): TenantConfig | undefined => {
    if (hash === KEY_HASH) {
      return makeTenantConfig('tenant-test-01', true);
    }
    return undefined;
  };

  it('valid API key returns 200 with correct tenantId', async () => {
    const app = buildApp(resolver);
    const res = await request(app)
      .get('/protected')
      .set('x-api-key', RAW_KEY);

    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe('tenant-test-01');
  });

  it('invalid API key returns 401', async () => {
    const app = buildApp(resolver);
    const res = await request(app)
      .get('/protected')
      .set('x-api-key', 'wrong-key');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_api_key');
  });

  it('missing API key returns 401', async () => {
    const app = buildApp(resolver);
    const res = await request(app).get('/protected');

    expect(res.status).toBe(401);
  });

  it('disabled tenant config returns 401', async () => {
    const disabledResolver = (hash: string): TenantConfig | undefined => {
      if (hash === KEY_HASH) {
        return makeTenantConfig('tenant-disabled', false);
      }
      return undefined;
    };
    const app = buildApp(disabledResolver);
    const res = await request(app)
      .get('/protected')
      .set('x-api-key', RAW_KEY);

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Input Sanitizer coexistence — API key auth + sanitizer both active
// ---------------------------------------------------------------------------

describe('Input Sanitizer coexistence with API key auth', () => {
  beforeEach(() => {
    process.env['INPUT_SANITIZER_ENABLED'] = 'true';
    delete process.env['INPUT_MAX_LENGTH'];
    sessionHistoryStore.clear();
  });

  afterEach(() => {
    delete process.env['INPUT_SANITIZER_ENABLED'];
  });

  it('sanitizer does not alter normal business message (coexistence guard)', () => {
    const result = sanitizeInput('返品ポリシーを教えてください', 'session-coexist-01');
    expect(result.allowed).toBe(true);
    expect(result.sanitizedMessage).toBe('返品ポリシーを教えてください');
  });

  it('sanitizer blocks URL even when API key auth would succeed', () => {
    // This tests that sanitizer runs independently of auth layer
    const result = sanitizeInput('http://evil.com/inject', 'session-coexist-02');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('url_detected');
  });

  it('sanitizer allows x-api-key style strings that are not URLs', () => {
    // API key values should not be blocked by sanitizer if used as chat messages (edge case)
    const apiKeyLike = 'sk-1234567890abcdef1234567890abcdef';
    const result = sanitizeInput(apiKeyLike, 'session-coexist-03');
    // No URL patterns in this string — should pass
    expect(result.allowed).toBe(true);
  });
});
