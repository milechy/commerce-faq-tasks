// src/api/admin/analytics/schemaHealthRoute.test.ts
// GET /v1/admin/analytics/measurement-health に合流させた **super_admin 限定の運用ペイロード**
// (スキーマ整合 / 点火状態)の HTTP 層テスト。
// 判定ロジックは schemaHealth.test.ts / ignitionStatus.test.ts で純関数として検証済みなので、
// ここでは「R2C運用にだけ出す」ことと「新エンドポイントを作っていない」ことだけを固定する。

import express from 'express';
import { request } from "../../../../tests/helpers/testServer";

const mockFetchMeasurementHealth = jest.fn();
const mockFetchSchemaHealth = jest.fn();
const mockFetchIgnitionStatus = jest.fn();
const mockFetchHermesAcceptanceRate = jest.fn();
const mockFetchFixedCostQuotaStatus = jest.fn();

jest.mock('./measurementHealth', () => ({
  fetchMeasurementHealth: (...args: unknown[]) => mockFetchMeasurementHealth(...args),
}));
jest.mock('./schemaHealth', () => ({
  fetchSchemaHealth: (...args: unknown[]) => mockFetchSchemaHealth(...args),
}));
jest.mock('./ignitionStatus', () => ({
  fetchIgnitionStatus: (...args: unknown[]) => mockFetchIgnitionStatus(...args),
}));
// A2A-0i: fetchFixedCostQuotaStatusも差し替える(空のpool({})に対して本物のクエリを
// 投げて例外になるのを避ける。fetchHermesAcceptanceRateと同じ理由)。
jest.mock('../../../lib/billing/billingHealthCheck', () => ({
  fetchFixedCostQuotaStatus: (...args: unknown[]) => mockFetchFixedCostQuotaStatus(...args),
}));
// H-7(GID 1217972930945091): fetchHermesAcceptanceRateだけ差し替える(他の
// summaryQueries.tsのexportは本物のまま。空のpool({})に対して本物のクエリを
// 投げて例外になるのを避けるのはfetchHermesAcceptanceRateだけで十分)。
jest.mock('./summaryQueries', () => ({
  ...jest.requireActual('./summaryQueries'),
  fetchHermesAcceptanceRate: (...args: unknown[]) => mockFetchHermesAcceptanceRate(...args),
}));

jest.mock('../../../lib/db', () => ({ pool: {}, getPool: () => ({}) }));
jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../lib/notifications', () => ({
  createNotification: jest.fn(),
  notificationExists: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = {
      app_metadata: {
        role: (req.headers['x-role'] as string) ?? 'client_admin',
        tenant_id: (req.headers['x-tenant-id'] as string) ?? 'tenant-A',
      },
    };
    next();
  },
}));

import { registerAnalyticsRoutes } from './routes';

function makeApp() {
  const app = express();
  app.use(express.json());
  registerAnalyticsRoutes(app);
  return app;
}

const BASE_HEALTH = {
  sourceBreakdown: [],
  emptySessionCount: 0,
  cvSessionLinkRate: { numerator: 0, denominator: 0, rate: null },
  outcomeRecordRate: { numerator: 0, denominator: 0, rate: null, autoRecorded: 0 },
  validUserSessionCount: 0,
};

describe('GET /v1/admin/analytics/measurement-health のスキーマ整合', () => {
  beforeEach(() => {
    mockFetchMeasurementHealth.mockReset().mockResolvedValue(BASE_HEALTH);
    mockFetchSchemaHealth.mockReset().mockResolvedValue({
      missing: [{ table: 'chat_sessions', columns: ['visitor_id'], tableMissing: false }],
      checkedTables: 34,
      checkedColumns: 257,
    });
    mockFetchIgnitionStatus.mockReset().mockResolvedValue({
      rows: [{ tenantId: 'carnation', cells: [] }],
      envControlledFeatures: ['judge_sweep'],
      anyEnabled: false,
    });
    mockFetchHermesAcceptanceRate.mockReset().mockResolvedValue({
      acceptanceRate: { numerator: 3, denominator: 4, rate: 75 },
      pendingCount: 5,
      asOf: '2026-08-30T00:00:00.000Z',
    });
    mockFetchFixedCostQuotaStatus.mockReset().mockResolvedValue({
      lemonslice: { used: 0, quota: 15000, ratio: 0, upSignal: false, downSignal: false, historyMonths: 0 },
      livekit: { used: 0, quota: null, ratio: null, upSignal: false, downSignal: false, historyMonths: 0 },
      asOf: '2026-08-30T00:00:00.000Z',
    });
  });

  it('super_admin には欠落列を返す', async () => {
    const res = await request(makeApp())
      .get('/v1/admin/analytics/measurement-health')
      .set('x-role', 'super_admin');

    expect(res.status).toBe(200);
    expect(res.body.schemaHealth.missing).toEqual([
      { table: 'chat_sessions', columns: ['visitor_id'], tableMissing: false },
    ]);
    expect(mockFetchSchemaHealth).toHaveBeenCalledTimes(1);
  });

  it('client_admin には返さない(R2C運用の情報であり、テナントの関心事ではない)', async () => {
    const res = await request(makeApp())
      .get('/v1/admin/analytics/measurement-health')
      .set('x-role', 'client_admin')
      .set('x-tenant-id', 'tenant-A');

    expect(res.status).toBe(200);
    expect(res.body.schemaHealth).toBeUndefined();
    expect(res.body.ignitionStatus).toBeUndefined();
    expect(res.body.hermesAcceptanceRate).toBeUndefined();
    expect(res.body.fixedCostQuota).toBeUndefined();
    expect(res.body.componentSelfcheck).toBeUndefined();
    // テナントに対して余計なクエリを投げない
    expect(mockFetchSchemaHealth).not.toHaveBeenCalled();
    expect(mockFetchIgnitionStatus).not.toHaveBeenCalled();
    expect(mockFetchHermesAcceptanceRate).not.toHaveBeenCalled();
    expect(mockFetchFixedCostQuotaStatus).not.toHaveBeenCalled();
    // 既存の計測ヘルス自体は従来どおり返る
    expect(res.body.validUserSessionCount).toBe(0);
  });

  // L0-4(Gate 0): hermes-dojo/hermes-vaultのselfcheck枠。DBを叩かない純関数
  // (componentSelfcheck.ts)なので個別にmockせず、実装をそのまま呼ばせる。
  it('super_admin にはhermes-dojo/hermes-vaultのselfcheckも返す(現状は配線が無いためnot_installed)', async () => {
    const res = await request(makeApp())
      .get('/v1/admin/analytics/measurement-health')
      .set('x-role', 'super_admin');

    expect(res.status).toBe(200);
    expect(res.body.componentSelfcheck).toEqual([
      { id: 'hermes-dojo', status: 'not_installed' },
      { id: 'hermes-vault', status: 'not_installed' },
    ]);
  });

  it('欠落なしのときも missing: [] を返す(「異常なし」を描けるようにする)', async () => {
    mockFetchSchemaHealth.mockResolvedValueOnce({ missing: [], checkedTables: 34, checkedColumns: 257 });

    const res = await request(makeApp())
      .get('/v1/admin/analytics/measurement-health')
      .set('x-role', 'super_admin');

    expect(res.body.schemaHealth.missing).toEqual([]);
    expect(res.body.schemaHealth.checkedTables).toBe(34);
  });

  it('super_admin には点火状態も返す(env でしか開閉できない機能を含む)', async () => {
    const res = await request(makeApp())
      .get('/v1/admin/analytics/measurement-health')
      .set('x-role', 'super_admin');

    expect(res.status).toBe(200);
    expect(res.body.ignitionStatus.rows[0].tenantId).toBe('carnation');
    expect(res.body.ignitionStatus.envControlledFeatures).toContain('judge_sweep');
    expect(res.body.ignitionStatus.anyEnabled).toBe(false);
  });

  // H-7(GID 1217972930945091): Hermes提案の採択率。集計ロジック自体(pendingの除外・
  // rate:nullの条件)は measurementHealth.test.ts の fetchHermesAcceptanceRate で
  // 純関数として検証済みなので、ここでは「super_adminにだけ合成される」ことだけを固定する。
  it('super_admin にはHermes提案の採択率も返す', async () => {
    const res = await request(makeApp())
      .get('/v1/admin/analytics/measurement-health')
      .set('x-role', 'super_admin');

    expect(res.status).toBe(200);
    expect(res.body.hermesAcceptanceRate).toEqual({
      acceptanceRate: { numerator: 3, denominator: 4, rate: 75 },
      pendingCount: 5,
      asOf: '2026-08-30T00:00:00.000Z',
    });
    expect(mockFetchHermesAcceptanceRate).toHaveBeenCalledTimes(1);
    // 全テナント横断の累計値であることを固定する: 呼び出しにtenantIdを渡していない
    // (渡してしまうと、fetchMeasurementHealthの他5指標のようにテナントで絞り込む
    // 実装に将来変わっても検知できない)。fetchHermesAcceptanceRate(db)はdb1引数の
    // シグネチャなので、呼び出し引数がpoolのみであることを確認する。
    expect(mockFetchHermesAcceptanceRate).toHaveBeenCalledWith(expect.anything());
    expect(mockFetchHermesAcceptanceRate.mock.calls[0]).toHaveLength(1);
  });

  it('母数不足(denominator=0)のときも rate:null をそのまま返す(0%に丸めない)', async () => {
    mockFetchHermesAcceptanceRate.mockResolvedValueOnce({
      acceptanceRate: { numerator: 0, denominator: 0, rate: null },
      pendingCount: 2,
      asOf: '2026-08-30T00:00:00.000Z',
    });

    const res = await request(makeApp())
      .get('/v1/admin/analytics/measurement-health')
      .set('x-role', 'super_admin');

    expect(res.body.hermesAcceptanceRate.acceptanceRate.rate).toBeNull();
    expect(res.body.hermesAcceptanceRate.acceptanceRate.denominator).toBe(0);
  });

  // A2A-0i: 固定費(LemonSlice/LiveKit)クォータ。判定ロジック自体(80%/50%閾値・
  // 3ヶ月連続判定)は billingHealthCheck.test.ts で純関数として検証済みなので、
  // ここでは「super_adminにだけ合成される」ことと「同じ計算関数を呼んでいる」ことだけを固定する。
  it('super_admin には固定費クォータの消費率も返す', async () => {
    mockFetchFixedCostQuotaStatus.mockResolvedValueOnce({
      lemonslice: { used: 13500, quota: 15000, ratio: 0.9, upSignal: true, downSignal: false, historyMonths: 3 },
      livekit: { used: 0, quota: null, ratio: null, upSignal: false, downSignal: false, historyMonths: 0 },
      asOf: '2026-08-30T00:00:00.000Z',
    });

    const res = await request(makeApp())
      .get('/v1/admin/analytics/measurement-health')
      .set('x-role', 'super_admin');

    expect(res.status).toBe(200);
    expect(res.body.fixedCostQuota.lemonslice.upSignal).toBe(true);
    expect(res.body.fixedCostQuota.livekit.quota).toBeNull();
    expect(mockFetchFixedCostQuotaStatus).toHaveBeenCalledTimes(1);
  });

  // ★発見した欠陥(直さず報告)★ 4本(fetchSchemaHealth/fetchIgnitionStatus/
  // fetchHermesAcceptanceRate/fetchFixedCostQuotaStatus)は routes.ts で
  // `Promise.all([...])` に束ねられており、どれか1本が例外を投げると全体が
  // rejectしてこのエンドポイント全体が500になる(routes.tsのcatchが
  // 「計測ヘルスの取得に失敗しました」で丸ごと落とす)。これは
  // fetchMeasurementHealth(基本の計測ヘルス5指標)自身の成功可否とも無関係に
  // 巻き込まれるため、fixedCostQuotaのDB障害1つで schemaHealth/ignitionStatus/
  // hermesAcceptanceRate と基本指標まで全損する — 前例(Asana 1217890011615276:
  // 「KPI/計測ヘルスの欠損で監視画面が全損する」)と同型のフェイルソフトでない構造。
  // it.failingで期待する挙動(fixedCostQuotaが壊れても他は生き残る)を明示したまま残す。
  it.failing('fetchFixedCostQuotaStatusが例外を投げても、他の運用カード(schemaHealth等)と基本の計測ヘルスは道連れにしない(フェイルソフト)', async () => {
    mockFetchFixedCostQuotaStatus.mockReset().mockRejectedValueOnce(new Error('db connection lost'));

    const res = await request(makeApp())
      .get('/v1/admin/analytics/measurement-health')
      .set('x-role', 'super_admin');

    expect(res.status).toBe(200);
    // fixedCostQuota自体は取得できなくても、他のカードと基本指標は生き残ってほしい
    expect(res.body.schemaHealth).toBeDefined();
    expect(res.body.ignitionStatus).toBeDefined();
    expect(res.body.hermesAcceptanceRate).toBeDefined();
    expect(res.body.validUserSessionCount).toBe(0);
  });
});
