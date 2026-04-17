// src/api/events/eventRoutes.conversionBridge.test.ts
// Phase65: chat_conversion → conversion_attributions ブリッジのユニットテスト

import express from 'express';
import request from 'supertest';
import { registerEventRoutes, bridgeConversionEvents } from './eventRoutes';

// ---------------------------------------------------------------------------
// DB モック
// ---------------------------------------------------------------------------

const mockQuery = jest.fn();
const mockDb = { query: mockQuery } as any;

// logger をモック (pino の quiet 化)
jest.mock('../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
import { logger } from '../../lib/logger';

// ---------------------------------------------------------------------------
// テスト用 Express アプリ
// ---------------------------------------------------------------------------

function makeApp(tenantId = 'carnation') {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.tenantId = tenantId;
    next();
  });
  registerEventRoutes(app, [], mockDb);
  return app;
}

// ---------------------------------------------------------------------------
// bridgeConversionEvents 直接テスト (ケース1-6)
// ---------------------------------------------------------------------------

describe('bridgeConversionEvents', () => {
  beforeEach(() => {
    mockQuery.mockClear();
    (logger.warn as jest.Mock).mockClear();
    (logger.error as jest.Mock).mockClear();
    (logger.info as jest.Mock).mockClear();
  });

  // ケース1: chat_conversion → INSERT される
  it('ケース1: chat_conversion なら conversion_attributions に INSERT される', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await bridgeConversionEvents(mockDb, 'tenant-1', '00000000-0000-0000-0000-000000000001', [
      { event_type: 'chat_conversion', event_data: { conversion_type: 'inquiry', conversion_value: 0 } },
    ]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO conversion_attributions');
    expect(params[0]).toBe('tenant-1');
    expect(params[2]).toBe('inquiry');
    expect(params[3]).toBe(0);
  });

  // ケース2: 他の event_type では INSERT されない
  it('ケース2: chat_conversion 以外の event_type では INSERT されない', async () => {
    await bridgeConversionEvents(mockDb, 'tenant-1', 'sess-1', [
      { event_type: 'page_view', event_data: {} },
      { event_type: 'chat_open', event_data: {} },
    ]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // ケース3: conversion_type が不正値 → INSERT されずwarningログ
  it('ケース3: conversion_type が不正な値なら INSERT されずwarning出力', async () => {
    await bridgeConversionEvents(mockDb, 'tenant-1', 'sess-1', [
      { event_type: 'chat_conversion', event_data: { conversion_type: 'invalid_type' } },
    ]);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversionType: 'invalid_type' }),
    );
  });

  // ケース4: session_id が UUID でない → session_id=NULL で INSERT
  it('ケース4: session_id が UUID でない場合は NULL で INSERT される', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await bridgeConversionEvents(mockDb, 'tenant-1', 'unknown', [
      { event_type: 'chat_conversion', event_data: { conversion_type: 'purchase', conversion_value: 2890000 } },
    ]);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[1]).toBeNull(); // session_id = null
  });

  // ケース5: DB INSERT 失敗でもエラーをスローしない (best-effort)
  it('ケース5: DB INSERT 失敗でも例外をスローしない', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB connection lost'));
    await expect(
      bridgeConversionEvents(mockDb, 'tenant-1', 'sess-1', [
        { event_type: 'chat_conversion', event_data: { conversion_type: 'inquiry', conversion_value: 0 } },
      ]),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: '[events→conversion bridge] insert failed' }),
    );
  });

  // ケース6: conversion_value が数値なら正しく保存、null ならnull
  it('ケース6: conversion_value が null/undefined の場合は null で保存', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 });
    await bridgeConversionEvents(mockDb, 't', '00000000-0000-0000-0000-000000000002', [
      { event_type: 'chat_conversion', event_data: { conversion_type: 'reservation' } },
    ]);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[3]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /api/events エンドポイント統合: レスポンスは常に202
// ---------------------------------------------------------------------------

describe('POST /api/events — CV bridge 込みでも202を維持', () => {
  beforeEach(() => mockQuery.mockClear());

  it('behavioral_events INSERT + bridge 両方成功で202', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 }) // behavioral_events
      .mockResolvedValueOnce({ rowCount: 1 }); // conversion_attributions
    const app = makeApp();
    const res = await request(app)
      .post('/api/events')
      .send({
        visitor_id: 'v1',
        session_id: '00000000-0000-0000-0000-000000000003',
        events: [{ event_type: 'chat_conversion', event_data: { conversion_type: 'inquiry', conversion_value: 0 } }],
      });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(1);
  });

  it('bridge INSERT が失敗しても202が返る', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })  // behavioral_events
      .mockRejectedValueOnce(new Error('bridge fail')); // conversion_attributions
    const app = makeApp();
    const res = await request(app)
      .post('/api/events')
      .send({
        visitor_id: 'v1',
        session_id: 'not-a-uuid',
        events: [{ event_type: 'chat_conversion', event_data: { conversion_type: 'purchase', conversion_value: 100000 } }],
      });
    expect(res.status).toBe(202);
  });
});
