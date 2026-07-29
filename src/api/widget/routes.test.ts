// src/api/widget/routes.test.ts
// GID 1216978855735482: GET /widget/:tenantSlug.js のアバターA/Bテスト割当まわりの回帰テスト

import express from 'express';
import request from 'supertest';
import { registerWidgetRoutes } from './routes';

jest.mock('./widgetGenerator', () => ({
  generateWidgetJs: jest.fn().mockImplementation(async (config: any) => {
    // 実際のobfuscationは行わず、渡された設定をそのままJSON文字列として埋め込む
    // （テストからassignmentの結果を検証しやすくするため）
    return `/* config: ${JSON.stringify(config)} */`;
  }),
}));

import { generateWidgetJs } from './widgetGenerator';

function makePool(queryResponses: Array<{ rows: any[]; rowCount?: number } | Error>) {
  let callCount = 0;
  return {
    query: jest.fn().mockImplementation(() => {
      const resp = queryResponses[callCount++] ?? { rows: [], rowCount: 0 };
      if (resp instanceof Error) return Promise.reject(resp);
      return Promise.resolve(resp);
    }),
  };
}

function makeApp(db: any) {
  const app = express();
  registerWidgetRoutes(app, db);
  return app;
}

describe('GET /widget/:tenantSlug.js', () => {
  beforeEach(() => {
    (generateWidgetJs as jest.Mock).mockClear();
  });

  it('DB未接続 → /widget.js へリダイレクト', async () => {
    const app = makeApp(null);
    const res = await request(app).get('/widget/tenant-a.js');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/widget.js');
  });

  it('テナントが存在しない → 404', async () => {
    const db = makePool([{ rows: [], rowCount: 0 }]);
    const app = makeApp(db);
    const res = await request(app).get('/widget/nonexistent.js');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('tenant_not_found');
  });

  it('テナント無効 → 404', async () => {
    const db = makePool([{ rows: [{ id: 'tenant-a', is_active: false, features: {} }], rowCount: 1 }]);
    const app = makeApp(db);
    const res = await request(app).get('/widget/tenant-a.js');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('tenant_inactive');
  });

  it('features.avatar=false のテナント → 実験を参照せずavatarEnabled=falseで生成（ガード）', async () => {
    const db = makePool([
      { rows: [{ id: 'tenant-a', is_active: true, features: { avatar: false } }], rowCount: 1 },
      // resolveAvatarAssignmentのガードにより ab_experiments へのクエリは発生しないはず
    ]);
    const app = makeApp(db);
    const res = await request(app).get('/widget/tenant-a.js');
    expect(res.status).toBe(200);
    const config = (generateWidgetJs as jest.Mock).mock.calls[0][0];
    expect(config.avatarEnabled).toBe(false);
    expect(config.abExperimentId).toBeNull();
    expect(config.abVariant).toBeNull();
    // tenants テーブルへの1回のクエリのみ（ab_experiments へは問い合わせない）
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('features.avatar=true かつ running なアバター実験なし → デフォルトのavatarEnabledをそのまま使う', async () => {
    const db = makePool([
      { rows: [{ id: 'tenant-a', is_active: true, features: { avatar: true } }], rowCount: 1 },
      { rows: [] }, // ab_experiments: running実験なし
    ]);
    const app = makeApp(db);
    const res = await request(app).get('/widget/tenant-a.js');
    expect(res.status).toBe(200);
    const config = (generateWidgetJs as jest.Mock).mock.calls[0][0];
    expect(config.avatarEnabled).toBe(true);
    expect(config.abExperimentId).toBeNull();
  });

  it('running なアバター実験あり → assignVariant結果に応じてavatarEnabledが上書きされる', async () => {
    const db = makePool([
      { rows: [{ id: 'tenant-a', is_active: true, features: { avatar: true } }], rowCount: 1 },
      {
        rows: [
          { id: 7, variant_a: { avatarEnabled: true }, variant_b: { avatarEnabled: false }, traffic_split: '0.5' },
        ],
      },
    ]);
    const app = makeApp(db);
    const res = await request(app).get('/widget/tenant-a.js');
    expect(res.status).toBe(200);
    const config = (generateWidgetJs as jest.Mock).mock.calls[0][0];
    expect(config.abExperimentId).toBe(7);
    expect(['a', 'b']).toContain(config.abVariant);
    expect(config.avatarEnabled).toBe(config.abVariant === 'a');
  });

  it('レスポンスヘッダ: Content-Type/Cache-Control/X-Content-Type-Options', async () => {
    const db = makePool([
      { rows: [{ id: 'tenant-a', is_active: true, features: { avatar: false } }], rowCount: 1 },
    ]);
    const app = makeApp(db);
    const res = await request(app).get('/widget/tenant-a.js');
    expect(res.headers['content-type']).toContain('application/javascript');
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('DBクエリ例外 → 500', async () => {
    const db = makePool([new Error('db down')]);
    const app = makeApp(db);
    const res = await request(app).get('/widget/tenant-a.js');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('widget_generation_failed');
  });
});
