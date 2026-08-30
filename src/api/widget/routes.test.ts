// src/api/widget/routes.test.ts
// GID 1216978855735482: GET /widget/:tenantSlug.js のアバターA/Bテスト割当まわりの回帰テスト

import express from 'express';
import { request } from "../../../tests/helpers/testServer";
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

describe('GET /widget/:tenantSlug.js — 「Powered by R2C」バッジ (PR-B)', () => {
  beforeEach(() => {
    (generateWidgetJs as jest.Mock).mockClear();
  });

  it('plan=starter → バッジを表示する(showBrandingBadge=true)', async () => {
    const db = makePool([
      { rows: [{ id: 'tenant-a', is_active: true, features: {}, plan: 'starter' }], rowCount: 1 },
    ]);
    const app = makeApp(db);
    await request(app).get('/widget/tenant-a.js');
    const config = (generateWidgetJs as jest.Mock).mock.calls[0][0];
    expect(config.showBrandingBadge).toBe(true);
  });

  it('plan=growth → バッジを表示しない(showBrandingBadge=false)', async () => {
    const db = makePool([
      { rows: [{ id: 'tenant-a', is_active: true, features: {}, plan: 'growth' }], rowCount: 1 },
    ]);
    const app = makeApp(db);
    await request(app).get('/widget/tenant-a.js');
    const config = (generateWidgetJs as jest.Mock).mock.calls[0][0];
    expect(config.showBrandingBadge).toBe(false);
  });

  it('plan=enterprise → バッジを表示しない', async () => {
    const db = makePool([
      { rows: [{ id: 'tenant-a', is_active: true, features: {}, plan: 'enterprise' }], rowCount: 1 },
    ]);
    const app = makeApp(db);
    await request(app).get('/widget/tenant-a.js');
    const config = (generateWidgetJs as jest.Mock).mock.calls[0][0];
    expect(config.showBrandingBadge).toBe(false);
  });

  it('plan=NULL(未設定) → fail-safeで「表示する」側に倒れる', async () => {
    const db = makePool([
      { rows: [{ id: 'tenant-a', is_active: true, features: {}, plan: null }], rowCount: 1 },
    ]);
    const app = makeApp(db);
    await request(app).get('/widget/tenant-a.js');
    const config = (generateWidgetJs as jest.Mock).mock.calls[0][0];
    expect(config.showBrandingBadge).toBe(true);
  });

  it('plan=未知の文字列 → fail-safeで「表示する」側に倒れる(Starterへ「昇格」しない)', async () => {
    const db = makePool([
      { rows: [{ id: 'tenant-a', is_active: true, features: {}, plan: 'gold' }], rowCount: 1 },
    ]);
    const app = makeApp(db);
    await request(app).get('/widget/tenant-a.js');
    const config = (generateWidgetJs as jest.Mock).mock.calls[0][0];
    expect(config.showBrandingBadge).toBe(true);
  });

  it('badgeUrl に UTM 4種 + r2c_ref(テナントID) が付与され、着地先が /lp/from-chat/ である', async () => {
    const db = makePool([
      { rows: [{ id: 'tenant-a', is_active: true, features: {}, plan: 'starter' }], rowCount: 1 },
    ]);
    const app = makeApp(db);
    await request(app).get('/widget/tenant-a.js');
    const config = (generateWidgetJs as jest.Mock).mock.calls[0][0];
    const url = new URL(config.badgeUrl);
    expect(url.pathname).toBe('/lp/from-chat/');
    expect(url.searchParams.get('utm_source')).toBe('widget');
    expect(url.searchParams.get('utm_medium')).toBe('badge');
    expect(url.searchParams.get('utm_campaign')).toBe('powered_by');
    expect(url.searchParams.get('r2c_ref')).toBe('tenant-a');
  });

  // 2026-08-24 実機確認で発覚した回帰: apex の r2c.biz は DNS が存在せず解決不能
  // （admin.r2c.biz / api.r2c.biz は稼働中）。LP_BASE_URL の既定値には、
  // 実際に public/lp/ を配信している到達可能なホストのみを使うこと。
  it('badgeUrl の既定ホストは解決不能な r2c.biz apex ではなく、稼働中の API_BASE_URL と一致する', async () => {
    const db = makePool([
      { rows: [{ id: 'tenant-a', is_active: true, features: {}, plan: 'starter' }], rowCount: 1 },
    ]);
    const app = makeApp(db);
    await request(app).get('/widget/tenant-a.js');
    const config = (generateWidgetJs as jest.Mock).mock.calls[0][0];
    const badgeUrlHost = new URL(config.badgeUrl).host;
    const apiBaseUrlHost = new URL(config.apiBaseUrl).host;
    expect(badgeUrlHost).toBe(apiBaseUrlHost);
    expect(badgeUrlHost).not.toBe('r2c.biz');
  });
});

describe('GET /widget/:tenantSlug.js — R2C自身の広告帯 (AD-2)', () => {
  beforeEach(() => {
    (generateWidgetJs as jest.Mock).mockClear();
  });

  it('plan=free_ad → 広告帯を表示する(showAdPromo=true)。バッジ側の理由でバッジも表示側のまま', async () => {
    const db = makePool([
      { rows: [{ id: 'tenant-a', is_active: true, features: {}, plan: 'free_ad' }], rowCount: 1 },
    ]);
    const app = makeApp(db);
    await request(app).get('/widget/tenant-a.js');
    const config = (generateWidgetJs as jest.Mock).mock.calls[0][0];
    expect(config.showAdPromo).toBe(true);
    expect(config.adPromoUrl).toEqual(expect.any(String));
    // widget.js 側は else if で広告帯を優先するため、showBrandingBadge がtrueのままでも
    // 実際に両方出ることはない(widgetSourceInvariants.test.ts / freeAdBadgeLogic.test.ts参照)。
    expect(config.showBrandingBadge).toBe(true);
  });

  it('plan=growth → 広告帯を表示しない(showAdPromo=false)', async () => {
    const db = makePool([
      { rows: [{ id: 'tenant-a', is_active: true, features: {}, plan: 'growth' }], rowCount: 1 },
    ]);
    const app = makeApp(db);
    await request(app).get('/widget/tenant-a.js');
    const config = (generateWidgetJs as jest.Mock).mock.calls[0][0];
    expect(config.showAdPromo).toBe(false);
  });

  it('plan=starter/standard/enterprise → 広告帯を表示しない', async () => {
    for (const plan of ['starter', 'standard', 'enterprise']) {
      const db = makePool([
        { rows: [{ id: 'tenant-a', is_active: true, features: {}, plan }], rowCount: 1 },
      ]);
      const app = makeApp(db);
      await request(app).get('/widget/tenant-a.js');
      const config = (generateWidgetJs as jest.Mock).mock.calls[0][0];
      expect(config.showAdPromo).toBe(false);
      (generateWidgetJs as jest.Mock).mockClear();
    }
  });

  it('plan=NULL(未設定) → fail-safeで「掲出しない」側に倒れる(バッジとは逆向き)', async () => {
    const db = makePool([
      { rows: [{ id: 'tenant-a', is_active: true, features: {}, plan: null }], rowCount: 1 },
    ]);
    const app = makeApp(db);
    await request(app).get('/widget/tenant-a.js');
    const config = (generateWidgetJs as jest.Mock).mock.calls[0][0];
    expect(config.showAdPromo).toBe(false);
  });

  it('plan=未知の文字列 → fail-safeで「掲出しない」側に倒れる(free_adへ誤って倒れない)', async () => {
    const db = makePool([
      { rows: [{ id: 'tenant-a', is_active: true, features: {}, plan: 'gold' }], rowCount: 1 },
    ]);
    const app = makeApp(db);
    await request(app).get('/widget/tenant-a.js');
    const config = (generateWidgetJs as jest.Mock).mock.calls[0][0];
    expect(config.showAdPromo).toBe(false);
  });

  it('adPromoUrl に UTM(ad_promo/free_ad) + r2c_ref(テナントID) が付与され、着地先が /lp/from-chat/ である', async () => {
    const db = makePool([
      { rows: [{ id: 'tenant-a', is_active: true, features: {}, plan: 'free_ad' }], rowCount: 1 },
    ]);
    const app = makeApp(db);
    await request(app).get('/widget/tenant-a.js');
    const config = (generateWidgetJs as jest.Mock).mock.calls[0][0];
    const url = new URL(config.adPromoUrl);
    expect(url.pathname).toBe('/lp/from-chat/');
    expect(url.searchParams.get('utm_source')).toBe('widget');
    expect(url.searchParams.get('utm_medium')).toBe('ad_promo');
    expect(url.searchParams.get('utm_campaign')).toBe('free_ad');
    expect(url.searchParams.get('r2c_ref')).toBe('tenant-a');
    // badgeのutm_mediumとは異なる値で、流入計測を混ぜない
    expect(url.searchParams.get('utm_medium')).not.toBe('badge');
  });
});

describe('GET /widget/:tenantSlug.js — バッジが表示されない既知の経路(仕様として固定)', () => {
  // CLAUDE.md 絶対にやってはいけないこと 38: この3経路は本PRでは是正せず、
  // 仕様として明示的に固定する。将来これを直す場合は、直したことが分かるように
  // このテストを書き換えること(黙って挙動が変わらないようにする)。

  it('①静的 /widget.js + data-tenant 埋め込みはこのルートを経由しない(プラン判定なし)', () => {
    // このルート(GET /widget/:tenantSlug.js)はテナントごとの動的生成専用。
    // 静的埋め込みは public/widget.js を直接配信するため、そもそもこのハンドラを通らない。
    // ここでは「動的ルートがバッジ制御の唯一の経路である」ことを明記するのみ(実行不要)。
    expect(true).toBe(true);
  });

  it('②db===nullのとき /widget.js へフォールバックし、バッジ制御ロジックを経由しない(fail-open)', async () => {
    const app = makeApp(null);
    const res = await request(app).get('/widget/tenant-a.js');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/widget.js');
    // このリダイレクト先(静的widget.js)はプラン判定を経由しないため、
    // plan由来のbadgeUrl/showBrandingBadgeは注入されない。
  });

  it('③レスポンスは Cache-Control: max-age=86400 のため、プラン変更の反映に最大24時間かかる', async () => {
    const db = makePool([
      { rows: [{ id: 'tenant-a', is_active: true, features: {}, plan: 'growth' }], rowCount: 1 },
    ]);
    const app = makeApp(db);
    const res = await request(app).get('/widget/tenant-a.js');
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
  });
});
