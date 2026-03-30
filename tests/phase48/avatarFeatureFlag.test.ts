// tests/phase48/avatarFeatureFlag.test.ts
// Bug-2: features.avatar フラグ未有効テナントへのアバターモード開通テスト
//
// livekitTokenRoutes: features.avatar=false → 403
// anamRoutes: features.avatar=false → 403

// ---------------------------------------------------------------------------
// livekitTokenRoutes — ロジックをユニットテストで検証（ルートは結合テストで困難なためロジック直接テスト）
// ---------------------------------------------------------------------------

// livekitTokenRoutes の avatar feature flag 判定ロジックをインラインで検証する
// (モジュールレベルの pool インポートをモックするより、ロジックの単体テストの方が堅牢)

function resolveAvatarEnabled(features: Record<string, unknown> | null): boolean {
  return features?.['avatar'] === true;
}

describe('livekitTokenRoutes — features.avatar flag logic', () => {
  it('returns false when features.avatar is false', () => {
    expect(resolveAvatarEnabled({ avatar: false })).toBe(false);
  });

  it('returns false when features is null', () => {
    expect(resolveAvatarEnabled(null)).toBe(false);
  });

  it('returns false when features.avatar is undefined', () => {
    expect(resolveAvatarEnabled({})).toBe(false);
  });

  it('returns true when features.avatar is true', () => {
    expect(resolveAvatarEnabled({ avatar: true })).toBe(true);
  });

  it('returns false when features.avatar is a truthy string (strict ===)', () => {
    expect(resolveAvatarEnabled({ avatar: 'true' } as any)).toBe(false);
  });

  it('returns false when features.avatar is 1 (strict ===)', () => {
    expect(resolveAvatarEnabled({ avatar: 1 } as any)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// livekitTokenRoutes — HTTP endpoint integration (with module mock)
// ---------------------------------------------------------------------------

// jest.mock must be hoisted, so we mock ../../src/lib/db at module level
const mockPoolQuery = jest.fn();
jest.mock('../../src/lib/db', () => ({
  pool: {
    query: (...args: any[]) => mockPoolQuery(...args),
  },
}));

import express from 'express';
import request from 'supertest';
import { registerLiveKitTokenRoutes } from '../../src/api/avatar/livekitTokenRoutes';
import { registerAnamRoutes } from '../../src/api/avatar/anamRoutes';

function mockAuthMiddleware(tenantId: string) {
  return (req: any, _res: any, next: any) => {
    req.tenantId = tenantId;
    next();
  };
}

describe('livekitTokenRoutes HTTP — features.avatar flag enforcement', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
  });

  it('returns 403 when features.avatar is false', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ features: { avatar: false }, lemonslice_agent_id: 'agent-1', is_active: true }],
      });

    const app = express();
    app.use(express.json());
    registerLiveKitTokenRoutes(app, [mockAuthMiddleware('tenant-no-avatar')]);

    const res = await request(app).post('/api/avatar/room-token');
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Avatar not enabled');
  });

  it('returns 403 when features is null', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ features: null, lemonslice_agent_id: 'agent-1', is_active: true }],
      });

    const app = express();
    app.use(express.json());
    registerLiveKitTokenRoutes(app, [mockAuthMiddleware('tenant-no-features')]);

    const res = await request(app).post('/api/avatar/room-token');
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// anamRoutes — POST /api/avatar/anam-session
// ---------------------------------------------------------------------------

function makeAnamMockPool(tenantRow: Record<string, unknown> | null, avatarConfigRow?: Record<string, unknown> | null) {
  return {
    query: jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('FROM tenants')) {
        if (!tenantRow) return Promise.resolve({ rowCount: 0, rows: [] });
        return Promise.resolve({ rowCount: 1, rows: [tenantRow] });
      }
      if (sql.includes('FROM avatar_configs')) {
        if (!avatarConfigRow) return Promise.resolve({ rowCount: 0, rows: [] });
        return Promise.resolve({ rowCount: 1, rows: [avatarConfigRow] });
      }
      return Promise.resolve({ rowCount: 0, rows: [] });
    }),
  };
}

describe('anamRoutes — features.avatar flag enforcement', () => {
  it('returns 403 when features.avatar is false', async () => {
    const mockPool = makeAnamMockPool(
      { features: { avatar: false }, is_active: true },
      { avatar_provider: 'anam', name: 'Test', personality_prompt: null, anam_avatar_id: 'av1', anam_voice_id: 'v1', anam_llm_id: null, anam_persona_id: null }
    );

    const app = express();
    app.use(express.json());
    app.locals.db = mockPool;

    const apiStack = [mockAuthMiddleware('tenant-anam-disabled')];
    registerAnamRoutes(app, apiStack);

    const res = await request(app)
      .post('/api/avatar/anam-session')
      .set('x-api-key', 'test-key');

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Avatar not enabled');
  });

  it('returns enabled:false when tenant is inactive', async () => {
    const mockPool = makeAnamMockPool(
      { features: { avatar: true }, is_active: false },
      null
    );

    const app = express();
    app.use(express.json());
    app.locals.db = mockPool;

    const apiStack = [mockAuthMiddleware('tenant-inactive')];
    registerAnamRoutes(app, apiStack);

    const res = await request(app)
      .post('/api/avatar/anam-session')
      .set('x-api-key', 'test-key');

    // Inactive tenant → soft fail (not 403)
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  it('proceeds to Anam API when features.avatar is true (ANAM_API_KEY not set → 200 enabled:false)', async () => {
    const mockPool = makeAnamMockPool(
      { features: { avatar: true }, is_active: true },
      { avatar_provider: 'anam', name: 'Alice', personality_prompt: null, anam_avatar_id: 'av1', anam_voice_id: 'v1', anam_llm_id: null, anam_persona_id: null }
    );

    const app = express();
    app.use(express.json());
    app.locals.db = mockPool;

    delete process.env['ANAM_API_KEY'];

    const apiStack = [mockAuthMiddleware('tenant-anam-ok')];
    registerAnamRoutes(app, apiStack);

    const res = await request(app)
      .post('/api/avatar/anam-session')
      .set('x-api-key', 'test-key');

    // ANAM_API_KEY not set → enabled:false (graceful degradation), but NOT 403
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });
});
