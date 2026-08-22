// src/lib/billing/stripeWebhook.test.ts
// Phase32: Stripe Webhook署名検証・イベント処理テスト

import { createStripeWebhookHandler } from './stripeWebhook';

// stripe をモック
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    webhooks: {
      constructEvent: jest.fn(),
    },
  }));
}, { virtual: true });

function makeReqRes(overrides: {
  body?: any;
  headers?: Record<string, string>;
}) {
  const req: any = {
    body:    overrides.body ?? Buffer.from('{}'),
    headers: overrides.headers ?? {},
    header:  (name: string) => overrides.headers?.[name.toLowerCase()],
  };
  const res: any = {
    _status: 200,
    _body:   null,
    status(code: number) { this._status = code; return this; },
    json(body: any)      { this._body = body; return this; },
  };
  return { req, res };
}

describe('createStripeWebhookHandler', () => {
  // rowCount: 1 が既定 = stripe_webhook_events への冪等INSERTが「新規」として通る状態。
  // 重複挙動を検証するテストでは個別に rowCount: 0 をmockする。
  const mockDb     = { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] }) };
  const mockLogger = {
    warn:  jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info:  jest.fn(),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_SECRET_KEY   = 'sk_test_dummy';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
    process.env.SLACK_WEBHOOK_URL   = undefined as any;
  });

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  it('stripe-signature ヘッダーがない場合は 400 を返す', async () => {
    const handler = createStripeWebhookHandler(mockDb as any, mockLogger);
    const { req, res } = makeReqRes({ headers: {} });

    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._body).toMatchObject({ error: 'missing_stripe_signature' });
  });

  it('STRIPE_WEBHOOK_SECRET が未設定の場合は 500 を返す', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const handler = createStripeWebhookHandler(mockDb as any, mockLogger);
    const { req, res } = makeReqRes({ headers: { 'stripe-signature': 'sig_xxx' } });

    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._body).toMatchObject({ error: 'webhook_not_configured' });
  });

  it('署名検証に失敗した場合は 400 を返す', async () => {
    // stripe.webhooks.constructEvent が例外を投げるようにモック
    const stripeMock = require('stripe');
    stripeMock.mockImplementationOnce(() => ({
      webhooks: {
        constructEvent: jest.fn().mockImplementation(() => {
          throw new Error('No signatures found matching the expected signature');
        }),
      },
    }));

    const handler = createStripeWebhookHandler(mockDb as any, mockLogger);
    const { req, res } = makeReqRes({
      body:    Buffer.from('{"type":"test"}'),
      headers: { 'stripe-signature': 'invalid_sig' },
    });

    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._body).toMatchObject({ error: 'invalid_signature' });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('invoice.payment_succeeded イベントで billing_status を paid に更新する', async () => {
    const invoice = {
      id:           'inv_001',
      subscription: 'sub_abc123',
      amount_due:   1000,
    };
    const event = { id: 'evt_001', type: 'invoice.payment_succeeded', data: { object: invoice } };

    const stripeMock = require('stripe');
    stripeMock.mockImplementationOnce(() => ({
      webhooks: {
        constructEvent: jest.fn().mockReturnValue(event),
      },
    }));

    const handler = createStripeWebhookHandler(mockDb as any, mockLogger);
    const { req, res } = makeReqRes({
      body:    Buffer.from(JSON.stringify(event)),
      headers: { 'stripe-signature': 'valid_sig' },
    });

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ received: true });
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining("billing_status = 'paid'"),
      ['sub_abc123']
    );
  });

  it('invoice.payment_failed イベントで warn ログを出す', async () => {
    const invoice = {
      id:           'inv_002',
      subscription: 'sub_abc456',
      amount_due:   2000,
    };
    const event = { id: 'evt_002', type: 'invoice.payment_failed', data: { object: invoice } };

    const stripeMock = require('stripe');
    stripeMock.mockImplementationOnce(() => ({
      webhooks: {
        constructEvent: jest.fn().mockReturnValue(event),
      },
    }));

    const handler = createStripeWebhookHandler(mockDb as any, mockLogger);
    const { req, res } = makeReqRes({
      body:    Buffer.from(JSON.stringify(event)),
      headers: { 'stripe-signature': 'valid_sig' },
    });

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: 'inv_002', subscriptionId: 'sub_abc456' }),
      expect.any(String)
    );
  });

  it('customer.subscription.deleted イベントでテナントを非アクティブ化する', async () => {
    const subscription = { id: 'sub_deleted_001' };
    const event = { id: 'evt_003', type: 'customer.subscription.deleted', data: { object: subscription } };

    const stripeMock = require('stripe');
    stripeMock.mockImplementationOnce(() => ({
      webhooks: {
        constructEvent: jest.fn().mockReturnValue(event),
      },
    }));

    const handler = createStripeWebhookHandler(mockDb as any, mockLogger);
    const { req, res } = makeReqRes({
      body:    Buffer.from(JSON.stringify(event)),
      headers: { 'stripe-signature': 'valid_sig' },
    });

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('is_active = false'),
      ['sub_deleted_001']
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'sub_deleted_001' }),
      expect.any(String)
    );
  });

  describe('冪等性: event.id の重複', () => {
    it('stripe_webhook_events への冪等INSERTを event.id / event.type で行う', async () => {
      const invoice = { id: 'inv_010', subscription: 'sub_idem_001', amount_due: 500 };
      const event = { id: 'evt_idem_001', type: 'invoice.payment_succeeded', data: { object: invoice } };

      const stripeMock = require('stripe');
      stripeMock.mockImplementationOnce(() => ({
        webhooks: { constructEvent: jest.fn().mockReturnValue(event) },
      }));

      const handler = createStripeWebhookHandler(mockDb as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      expect(res._status).toBe(200);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT (event_id) DO NOTHING'),
        ['evt_idem_001', 'invoice.payment_succeeded']
      );
    });

    it('同一 event.id の再送で、前回completed_at済み（=ハンドラが最後まで成功済み）なら副作用をスキップし received:true, duplicate:true を返す', async () => {
      const invoice = { id: 'inv_011', subscription: 'sub_idem_002', amount_due: 700 };
      const event = { id: 'evt_idem_002', type: 'invoice.payment_succeeded', data: { object: invoice } };

      // 冪等INSERTが ON CONFLICT に当たり（rowCount: 0）、続くSELECTで
      // completed_at が設定済み ＝ 前回ハンドラが最後まで成功している状態。
      const dedupDb = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // dedup insert: 重複
          .mockResolvedValueOnce({ rows: [{ completed_at: new Date() }] }), // completed_at 確認: 完了済み
      };

      const stripeMock = require('stripe');
      stripeMock.mockImplementationOnce(() => ({
        webhooks: { constructEvent: jest.fn().mockReturnValue(event) },
      }));

      const handler = createStripeWebhookHandler(dedupDb as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      expect(res._status).toBe(200);
      expect(res._body).toEqual({ received: true, duplicate: true });
      // dedup INSERT + completed_at確認SELECT の2回のみ。billing_status 更新は呼ばれない
      expect(dedupDb.query).toHaveBeenCalledTimes(2);
      expect(dedupDb.query).not.toHaveBeenCalledWith(
        expect.stringContaining("billing_status = 'paid'"),
        expect.anything()
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: 'evt_idem_002', eventType: 'invoice.payment_succeeded' }),
        expect.any(String)
      );
    });

    it('同一 event.id の再送で、前回completed_at未設定（=ハンドラ未完了）なら副作用を再試行する', async () => {
      const invoice = { id: 'inv_011b', subscription: 'sub_idem_002b', amount_due: 700 };
      const event = { id: 'evt_idem_002b', type: 'invoice.payment_succeeded', data: { object: invoice } };

      const retryDb = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // dedup insert: 重複
          .mockResolvedValueOnce({ rows: [{ completed_at: null }] }) // completed_at確認: 未完了
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // billing_status更新: 今回は成功
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }), // completed_atマーク
      };

      const stripeMock = require('stripe');
      stripeMock.mockImplementationOnce(() => ({
        webhooks: { constructEvent: jest.fn().mockReturnValue(event) },
      }));

      const handler = createStripeWebhookHandler(retryDb as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      expect(res._status).toBe(200);
      expect(res._body).toEqual({ received: true }); // duplicateフラグ無し = 実際に処理された
      expect(retryDb.query).toHaveBeenCalledWith(
        expect.stringContaining("billing_status = 'paid'"),
        ['sub_idem_002b']
      );
      expect(retryDb.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE stripe_webhook_events SET completed_at'),
        ['evt_idem_002b']
      );
    });

    it('署名不正の場合は冪等チェックより前に拒否される（重複INSERTしない）', async () => {
      const dedupDb = { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] }) };
      const stripeMock = require('stripe');
      stripeMock.mockImplementationOnce(() => ({
        webhooks: {
          constructEvent: jest.fn().mockImplementation(() => {
            throw new Error('No signatures found matching the expected signature');
          }),
        },
      }));

      const handler = createStripeWebhookHandler(dedupDb as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from('{"type":"test"}'),
        headers: { 'stripe-signature': 'invalid_sig' },
      });

      await handler(req, res);

      expect(res._status).toBe(400);
      expect(dedupDb.query).not.toHaveBeenCalled();
    });

    it('同一event.idが連続で2回配信された場合、1回目は処理され2回目のみ重複扱いになる（実際のハンドラ呼び出しをまたぐ検証）', async () => {
      const invoice = { id: 'inv_012', subscription: 'sub_idem_003', amount_due: 300 };
      const event = { id: 'evt_idem_003', type: 'invoice.payment_succeeded', data: { object: invoice } };

      // 1回目: dedup insert新規 → billing_status更新 → completed_atマーク（成功で完結）
      // 2回目: dedup insert重複 → completed_at確認 → 完了済みなのでスキップ
      const sequentialDb = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // dedup insert #1: 新規
          .mockResolvedValueOnce({ rowCount: 5, rows: [] }) // billing_status update #1
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // completed_atマーク #1
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // dedup insert #2: 重複
          .mockResolvedValueOnce({ rows: [{ completed_at: new Date() }] }), // completed_at確認 #2: 完了済み
      };

      const stripeMock = require('stripe');
      stripeMock.mockImplementation(() => ({
        webhooks: { constructEvent: jest.fn().mockReturnValue(event) },
      }));

      const handler = createStripeWebhookHandler(sequentialDb as any, mockLogger);
      const { req: req1, res: res1 } = makeReqRes({
        body: Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });
      const { req: req2, res: res2 } = makeReqRes({
        body: Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req1, res1);
      await handler(req2, res2);

      expect(res1._body).toEqual({ received: true });
      expect(res2._body).toEqual({ received: true, duplicate: true });
      expect(sequentialDb.query).toHaveBeenCalledTimes(5);
    });

    it('[修正確認] 冪等INSERT成功後にハンドラが失敗しても、completed_atが未設定のため再送時に副作用が再試行される', async () => {
      // 1回目: dedup insert新規 → billing_status更新が失敗 → completed_atはマークされない(500)
      // 2回目(Stripeの自動再送): dedup insert重複 → completed_at確認で未完了と判明 →
      //   'retry'としてbilling_status更新を再試行し、今度は成功してcompleted_atをマークする。
      const invoice = { id: 'inv_013', subscription: 'sub_poison', amount_due: 999 };
      const event = { id: 'evt_poison_001', type: 'invoice.payment_succeeded', data: { object: invoice } };

      const recoveringDb = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // 1回目 dedup insert: 新規
          .mockRejectedValueOnce(new Error('DB connection lost')) // 1回目 billing_status更新: 失敗
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // 2回目 dedup insert: 重複
          .mockResolvedValueOnce({ rows: [{ completed_at: null }] }) // 2回目 completed_at確認: 未完了 → retry
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // 2回目 billing_status更新: 今度は成功
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }), // 2回目 completed_atマーク
      };

      const stripeMock = require('stripe');
      stripeMock.mockImplementation(() => ({
        webhooks: { constructEvent: jest.fn().mockReturnValue(event) },
      }));

      const handler = createStripeWebhookHandler(recoveringDb as any, mockLogger);

      // 1回目: ハンドラ内で例外 → 500（Stripeは5xxで再送する）
      const { req: req1, res: res1 } = makeReqRes({
        body: Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });
      await handler(req1, res1);
      expect(res1._status).toBe(500);

      // 2回目(再送): completed_at未設定と分かり再試行 → 今回は成功
      const { req: req2, res: res2 } = makeReqRes({
        body: Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });
      await handler(req2, res2);
      expect(res2._status).toBe(200);
      expect(res2._body).toEqual({ received: true }); // duplicateフラグ無し = 実際に再試行され成功した

      const billingUpdateCalls = recoveringDb.query.mock.calls.filter(([sql]) =>
        typeof sql === 'string' && sql.includes("billing_status = 'paid'")
      );
      expect(billingUpdateCalls).toHaveLength(2); // 1回目(失敗)・2回目(成功)の両方試行された
      const markCompletedCalls = recoveringDb.query.mock.calls.filter(([sql]) =>
        typeof sql === 'string' && sql.includes('UPDATE stripe_webhook_events SET completed_at')
      );
      expect(markCompletedCalls).toHaveLength(1); // 成功した2回目のみマークされる
    });

    it('冪等INSERT自体がDBエラーで失敗した場合、200を返さずエラーとして扱う（誤って"処理済み"にしない）', async () => {
      const invoice = { id: 'inv_014', subscription: 'sub_dberr', amount_due: 100 };
      const event = { id: 'evt_dberr_001', type: 'invoice.payment_succeeded', data: { object: invoice } };

      const failingDb = {
        query: jest.fn().mockRejectedValueOnce(new Error('connection timeout')),
      };

      const stripeMock = require('stripe');
      stripeMock.mockImplementationOnce(() => ({
        webhooks: { constructEvent: jest.fn().mockReturnValue(event) },
      }));

      const handler = createStripeWebhookHandler(failingDb as any, mockLogger);
      const { req, res } = makeReqRes({
        body: Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      // 冪等INSERT自体の失敗は「重複」ではなくハンドラエラーとして扱われ、
      // Stripeに再送を促すため 200 を返してはならない。
      expect(res._status).toBe(500);
      expect(res._body).not.toMatchObject({ received: true });
    });

    it('event.id が undefined の異常なイベントでも同期的に例外を投げず、DBクエリへ処理を委譲する', async () => {
      // Stripe SDK の constructEvent は通常 event.id を必ず含むオブジェクトを返すが、
      // モック/改ざん耐性として「idが無い」場合にサーバが同期クラッシュしないことを確認する。
      // 実際の一意性制約はDBスキーマ側の責務であり、ここではアプリ層が例外を吸収し
      // 500として扱うことのみを検証する（重複判定を誤ってtrueにしない）。
      const malformedEvent = { type: 'invoice.payment_succeeded', data: { object: { id: 'inv_x' } } };

      const strictDb = {
        query: jest.fn().mockRejectedValueOnce(
          new Error('null value in column "event_id" violates not-null constraint')
        ),
      };

      const stripeMock = require('stripe');
      stripeMock.mockImplementationOnce(() => ({
        webhooks: { constructEvent: jest.fn().mockReturnValue(malformedEvent) },
      }));

      const handler = createStripeWebhookHandler(strictDb as any, mockLogger);
      const { req, res } = makeReqRes({
        body: Buffer.from(JSON.stringify(malformedEvent)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await expect(handler(req, res)).resolves.not.toThrow();
      expect(res._status).toBe(500);
    });
  });
});
