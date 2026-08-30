// src/api/conversion/abExposureRoutes.test.ts
// GID 1216978855735482: アバター効果A/Bテスト基盤 — 露出記録エンドポイント

import express from 'express';
import { request } from "../../../tests/helpers/testServer";
import { registerAbExposureRoutes } from './abExposureRoutes';

const VALID_SESSION_ID = '11111111-1111-1111-1111-111111111111';

function makeApp(opts: {
  tenantId?: string | null;
  queryResponses?: Array<{ rows: any[]; rowCount?: number } | Error>;
  dbNull?: boolean;
}) {
  const { tenantId = 'tenant-a', queryResponses = [] } = opts;
  const app = express();
  app.use(express.json());

  const authMw = (req: any, _res: any, next: any) => {
    if (tenantId !== null) req.tenantId = tenantId;
    next();
  };

  let callCount = 0;
  const mockDb: any = opts.dbNull
    ? null
    : {
        query: jest.fn().mockImplementation(() => {
          const resp = queryResponses[callCount++] ?? { rows: [], rowCount: 0 };
          if (resp instanceof Error) return Promise.reject(resp);
          return Promise.resolve(resp);
        }),
      };

  registerAbExposureRoutes(app, [authMw], mockDb);
  return { app, mockDb };
}

describe('POST /v1/ab/avatar-exposure', () => {
  it('正常系: runningな実験に対する露出を202で受理する', async () => {
    const { app, mockDb } = makeApp({
      queryResponses: [
        { rows: [{ 1: 1 }], rowCount: 1 }, // ab_experiments存在確認
        { rows: [], rowCount: 0 }, // INSERT
      ],
    });
    const res = await request(app)
      .post('/v1/ab/avatar-exposure')
      .send({ experiment_id: 9, variant: 'a', session_id: VALID_SESSION_ID });
    expect(res.status).toBe(202);
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it('tenantId不明（未認証） → 401', async () => {
    const { app } = makeApp({ tenantId: null });
    const res = await request(app)
      .post('/v1/ab/avatar-exposure')
      .send({ experiment_id: 9, variant: 'a', session_id: VALID_SESSION_ID });
    expect(res.status).toBe(401);
  });

  it('DB未接続 → 503', async () => {
    const { app } = makeApp({ dbNull: true });
    const res = await request(app)
      .post('/v1/ab/avatar-exposure')
      .send({ experiment_id: 9, variant: 'a', session_id: VALID_SESSION_ID });
    expect(res.status).toBe(503);
  });

  it('session_idがUUID形式でない → 400', async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post('/v1/ab/avatar-exposure')
      .send({ experiment_id: 9, variant: 'a', session_id: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('variantが a/b 以外 → 400', async () => {
    const { app } = makeApp({});
    const res = await request(app)
      .post('/v1/ab/avatar-exposure')
      .send({ experiment_id: 9, variant: 'c', session_id: VALID_SESSION_ID });
    expect(res.status).toBe(400);
  });

  it('experiment_idが自テナントのrunning実験でない（他テナント/存在しない/draft等）→ 404', async () => {
    const { app, mockDb } = makeApp({
      queryResponses: [{ rows: [], rowCount: 0 }], // ab_experiments存在確認 → 該当なし
    });
    const res = await request(app)
      .post('/v1/ab/avatar-exposure')
      .send({ experiment_id: 999, variant: 'a', session_id: VALID_SESSION_ID });
    expect(res.status).toBe(404);
    // 存在確認で弾かれるため、INSERT(recordAvatarExposure)は呼ばれない
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });

  it('存在確認クエリがtenant_idで絞り込んでいる（クロステナント汚染防止）', async () => {
    const { app, mockDb } = makeApp({
      tenantId: 'tenant-a',
      queryResponses: [{ rows: [{ 1: 1 }], rowCount: 1 }, { rows: [] }],
    });
    await request(app)
      .post('/v1/ab/avatar-exposure')
      .send({ experiment_id: 9, variant: 'a', session_id: VALID_SESSION_ID });
    const [sql, params] = (mockDb.query as jest.Mock).mock.calls[0];
    expect(sql).toContain('tenant_id = $2');
    expect(params).toEqual([9, 'tenant-a']);
  });
});
