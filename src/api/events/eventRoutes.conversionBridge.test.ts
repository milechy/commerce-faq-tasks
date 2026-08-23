// src/api/events/eventRoutes.conversionBridge.test.ts
// Phase65 / PR-5訂正 (GID 1216970103691946): chat_conversion → conversion_attributions
// ブリッジのユニットテスト。
//
// 旧判定基準(「session_idがUUIDの形をしていればそのまま入れる」)は、widgetの
// r2c_sid(sessionStorage)を conversion_attributions.session_id に誤って入れており、
// chat_sessions.id と一致しないため本番で0件しか結合できていなかった不具合の原因
// そのものだった。新判定基準は「chat_session_id(=chat_sessions.session_id)または
// visitor_id(=chat_sessions.visitor_id)から chat_sessions.id を解決できたときだけ
// session_idを入れ、できなければNULL」。

import express from 'express';
import request from 'supertest';
import {
  registerEventRoutes,
  bridgeConversionEvents,
  resolveChatSessionUuid,
  autoRecordOutcome,
} from './eventRoutes';
import { AUTO_OUTCOME_RECORDED_BY } from '../admin/chat-history/chatHistoryRepository';

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

// GID 1216970103691946 (PR-6): autoRecordOutcome が使う chatHistoryRepository をモック
const mockGetConversionTypes = jest.fn();
const mockGetSessionOutcome = jest.fn();
const mockRecordOutcome = jest.fn();
jest.mock('../admin/chat-history/chatHistoryRepository', () => ({
  AUTO_OUTCOME_RECORDED_BY: 'system:cv_bridge',
  getConversionTypes: (...args: unknown[]) => mockGetConversionTypes(...args),
  getSessionOutcome: (...args: unknown[]) => mockGetSessionOutcome(...args),
  recordOutcome: (...args: unknown[]) => mockRecordOutcome(...args),
}));

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

// autoRecordOutcome(chatHistoryRepository経由)は resolveChatSessionUuid/bridgeConversionEvents
// のどのテストでも走りうる(sessionIdForAttributionが解決された時点で常に呼ばれる)ため、
// 安全なデフォルト値を全テストに適用する。個別テストは必要に応じて上書きする。
beforeEach(() => {
  mockGetConversionTypes.mockReset().mockResolvedValue(['購入完了', '予約完了', '問い合わせ送信', '離脱', '不明']);
  mockGetSessionOutcome.mockReset().mockResolvedValue(null);
  mockRecordOutcome.mockReset().mockResolvedValue({ outcome: '購入完了', recordedAt: '2026-08-23T00:00:00.000Z', recordedBy: AUTO_OUTCOME_RECORDED_BY });
});

// ---------------------------------------------------------------------------
// resolveChatSessionUuid 単体テスト
// ---------------------------------------------------------------------------

describe('resolveChatSessionUuid', () => {
  beforeEach(() => mockQuery.mockClear());

  it('chat_session_idがchat_sessions.session_idに一致すればそのidを返す', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'uuid-resolved-1' }] });
    const result = await resolveChatSessionUuid(mockDb, 'tenant-1', { chatSessionId: 'conv-abc' });
    expect(result).toBe('uuid-resolved-1');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('session_id = $2');
    expect(params).toEqual(['tenant-1', 'conv-abc']);
  });

  it('chat_session_idで解決できなければvisitor_idにフォールバックする', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // chat_session_id 不一致
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-resolved-2' }] }); // visitor_id で発見
    const result = await resolveChatSessionUuid(mockDb, 'tenant-1', {
      chatSessionId: 'conv-unknown',
      visitorId: 'v1',
    });
    expect(result).toBe('uuid-resolved-2');
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [sql2, params2] = mockQuery.mock.calls[1];
    expect(sql2).toContain('visitor_id = $2');
    expect(sql2).toContain('ORDER BY started_at DESC');
    expect(params2).toEqual(['tenant-1', 'v1']);
  });

  it('chat_session_id・visitor_idどちらも無ければDBに問い合わせずnullを返す', async () => {
    const result = await resolveChatSessionUuid(mockDb, 'tenant-1', {});
    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('chat_session_id・visitor_idともに解決できなければnullを返す(2クエリとも空)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    const result = await resolveChatSessionUuid(mockDb, 'tenant-1', {
      chatSessionId: 'conv-x',
      visitorId: 'v-x',
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// bridgeConversionEvents 直接テスト
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// autoRecordOutcome 単体テスト
// ---------------------------------------------------------------------------

describe('autoRecordOutcome', () => {
  it('conversion_type(purchase)をテナントのconversion_typesにある「購入完了」にマッピングして記録する', async () => {
    await autoRecordOutcome('tenant-1', 'uuid-resolved', 'purchase');
    expect(mockGetConversionTypes).toHaveBeenCalledWith('tenant-1');
    expect(mockRecordOutcome).toHaveBeenCalledWith({
      sessionDbId: 'uuid-resolved',
      tenantId: 'tenant-1',
      outcome: '購入完了',
      recordedBy: AUTO_OUTCOME_RECORDED_BY,
    });
  });

  it.each([
    ['reservation', '予約完了'],
    ['inquiry', '問い合わせ送信'],
  ] as const)('conversion_type(%s)を「%s」にマッピングする', async (conversionType, expectedLabel) => {
    await autoRecordOutcome('tenant-1', 'uuid-resolved', conversionType);
    expect(mockRecordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: expectedLabel }));
  });

  it.each(['signup', 'other'] as const)(
    'conversion_type(%s)は対応するテナント表記が無いため記録しない',
    async (conversionType) => {
      await autoRecordOutcome('tenant-1', 'uuid-resolved', conversionType);
      expect(mockGetConversionTypes).not.toHaveBeenCalled();
      expect(mockRecordOutcome).not.toHaveBeenCalled();
    },
  );

  it('マッピング先の言葉がテナントのconversion_typesに含まれなければ記録しない(カスタムテナント)', async () => {
    mockGetConversionTypes.mockResolvedValue(['成約', 'キャンセル']); // '購入完了' が無い
    await autoRecordOutcome('tenant-custom', 'uuid-resolved', 'purchase');
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  it('既にoutcomeが記録済み(人手/自動問わず)なら上書きしない', async () => {
    mockGetSessionOutcome.mockResolvedValue({ outcome: '離脱', outcomeRecordedAt: '2026-08-01T00:00:00.000Z', outcomeRecordedBy: 'staff@example.com' });
    await autoRecordOutcome('tenant-1', 'uuid-resolved', 'purchase');
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });
});

describe('bridgeConversionEvents', () => {
  beforeEach(() => {
    mockQuery.mockClear();
    (logger.warn as jest.Mock).mockClear();
    (logger.error as jest.Mock).mockClear();
    (logger.info as jest.Mock).mockClear();
  });

  it('chat_session_idが解決できれば、解決したchat_sessions.idでINSERTされる', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-resolved' }] }) // resolve
      .mockResolvedValueOnce({ rowCount: 1 }); // INSERT
    await bridgeConversionEvents(mockDb, 'tenant-1', { chatSessionId: 'conv-1' }, [
      { event_type: 'chat_conversion', event_data: { conversion_type: 'inquiry', conversion_value: 0 } },
    ]);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toContain('INSERT INTO conversion_attributions');
    expect(sql).toContain('event_id');
    expect(params[0]).toBe('tenant-1');
    expect(params[1]).toBe('uuid-resolved');
    expect(params[2]).toBe('inquiry');
    expect(params[3]).toBe(0);
  });

  it('INSERT成功後、解決済みsession_idでoutcome自動記録を試みる(GID 1216970103691946)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-resolved' }] }) // resolve
      .mockResolvedValueOnce({ rowCount: 1 }); // INSERT
    await bridgeConversionEvents(mockDb, 'tenant-1', { chatSessionId: 'conv-1' }, [
      { event_type: 'chat_conversion', event_data: { conversion_type: 'inquiry', conversion_value: 0 } },
    ]);
    expect(mockRecordOutcome).toHaveBeenCalledWith({
      sessionDbId: 'uuid-resolved',
      tenantId: 'tenant-1',
      outcome: '問い合わせ送信',
      recordedBy: AUTO_OUTCOME_RECORDED_BY,
    });
  });

  it('session_idが解決できなければoutcome自動記録も試みない(NULLセッションに記録できないため)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // INSERTのみ(resolveは0クエリ)
    await bridgeConversionEvents(mockDb, 'tenant-1', {}, [
      { event_type: 'chat_conversion', event_data: { conversion_type: 'inquiry', conversion_value: 0 } },
    ]);
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  it('chat_conversion以外のevent_typeでは resolve も INSERT も行われない', async () => {
    await bridgeConversionEvents(mockDb, 'tenant-1', { chatSessionId: 'conv-1' }, [
      { event_type: 'page_view', event_data: {} },
      { event_type: 'chat_open', event_data: {} },
    ]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('conversion_typeが不正な値ならINSERTされずwarning出力(resolveは実行される)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'uuid-resolved' }] }); // resolve のみ
    await bridgeConversionEvents(mockDb, 'tenant-1', { chatSessionId: 'conv-1' }, [
      { event_type: 'chat_conversion', event_data: { conversion_type: 'invalid_type' } },
    ]);
    expect(mockQuery).toHaveBeenCalledTimes(1); // resolveの1回のみ、INSERTは無し
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ conversionType: 'invalid_type' }),
    );
  });

  it('chat_session_id・visitor_idどちらも無ければ resolve自体を問い合わせずsession_id=NULLでINSERTされる', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // INSERTのみ(resolveは0クエリ)
    await bridgeConversionEvents(mockDb, 'tenant-1', {}, [
      { event_type: 'chat_conversion', event_data: { conversion_type: 'purchase', conversion_value: 2890000 } },
    ]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockQuery.mock.calls[0];
    expect(params[1]).toBeNull(); // session_id = null
  });

  it('chat_session_id・visitor_idともに解決できなければsession_id=NULLでINSERTされる', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // chat_session_id不一致
      .mockResolvedValueOnce({ rows: [] }) // visitor_idも不一致
      .mockResolvedValueOnce({ rowCount: 1 }); // INSERT
    await bridgeConversionEvents(
      mockDb,
      'tenant-1',
      { chatSessionId: 'conv-unknown', visitorId: 'v-unknown' },
      [{ event_type: 'chat_conversion', event_data: { conversion_type: 'purchase', conversion_value: 2890000 } }],
    );
    const [, params] = mockQuery.mock.calls[2];
    expect(params[1]).toBeNull();
  });

  it('resolve自体が例外を投げてもsession_id=NULLで継続する(best-effort)', async () => {
    mockQuery
      .mockRejectedValueOnce(new Error('DB connection lost')) // resolve失敗
      .mockResolvedValueOnce({ rowCount: 1 }); // INSERT
    await bridgeConversionEvents(mockDb, 'tenant-1', { chatSessionId: 'conv-1' }, [
      { event_type: 'chat_conversion', event_data: { conversion_type: 'inquiry', conversion_value: 0 } },
    ]);
    const [, params] = mockQuery.mock.calls[1];
    expect(params[1]).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: '[events→conversion bridge] session resolve failed' }),
    );
  });

  it('DB INSERT失敗でも例外をスローしない (best-effort)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-resolved' }] }) // resolve
      .mockRejectedValueOnce(new Error('DB connection lost')); // INSERT失敗
    await expect(
      bridgeConversionEvents(mockDb, 'tenant-1', { chatSessionId: 'conv-1' }, [
        { event_type: 'chat_conversion', event_data: { conversion_type: 'inquiry', conversion_value: 0 } },
      ]),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: '[events→conversion bridge] insert failed' }),
    );
  });

  it('conversion_valueがnull/undefinedの場合はnullで保存', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-resolved' }] })
      .mockResolvedValueOnce({ rowCount: 1 });
    await bridgeConversionEvents(mockDb, 't', { chatSessionId: 'conv-2' }, [
      { event_type: 'chat_conversion', event_data: { conversion_type: 'reservation' } },
    ]);
    const [, params] = mockQuery.mock.calls[1];
    expect(params[3]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /api/events エンドポイント統合: レスポンスは常に202
// ---------------------------------------------------------------------------

describe('POST /api/events — CV bridge 込みでも202を維持', () => {
  beforeEach(() => mockQuery.mockClear());

  it('behavioral_events INSERT + resolve + bridge 全て成功で202', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 }) // behavioral_events
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-resolved' }] }) // resolve(chat_session_id一致)
      .mockResolvedValueOnce({ rowCount: 1 }); // conversion_attributions
    const app = makeApp();
    const res = await request(app)
      .post('/api/events')
      .send({
        visitor_id: 'v1',
        session_id: 'r2c-sid-abc', // behavioral_events用(r2c_sid)。conversion_attributionsの結合には使わない
        chat_session_id: 'conv-1',
        events: [{ event_type: 'chat_conversion', event_data: { conversion_type: 'inquiry', conversion_value: 0 } }],
      });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(1);
  });

  it('chat_session_id未指定でも202が返り、session_id=NULLでbridgeされる', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 }) // behavioral_events
      .mockResolvedValueOnce({ rowCount: 1 }); // conversion_attributions (resolveは0クエリ)
    const app = makeApp();
    const res = await request(app)
      .post('/api/events')
      .send({
        visitor_id: 'v1',
        session_id: 'r2c-sid-abc',
        events: [{ event_type: 'chat_conversion', event_data: { conversion_type: 'purchase', conversion_value: 100000 } }],
      });
    expect(res.status).toBe(202);
  });

  it('bridge INSERT が失敗しても202が返る', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 }) // behavioral_events
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-resolved' }] }) // resolve
      .mockRejectedValueOnce(new Error('bridge fail')); // conversion_attributions
    const app = makeApp();
    const res = await request(app)
      .post('/api/events')
      .send({
        visitor_id: 'v1',
        session_id: 'r2c-sid-abc',
        chat_session_id: 'conv-1',
        events: [{ event_type: 'chat_conversion', event_data: { conversion_type: 'purchase', conversion_value: 100000 } }],
      });
    expect(res.status).toBe(202);
  });
});
