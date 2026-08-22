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

    it('同一 event.id の再送では副作用（DB更新等）をスキップし received:true, duplicate:true を返す', async () => {
      const invoice = { id: 'inv_011', subscription: 'sub_idem_002', amount_due: 700 };
      const event = { id: 'evt_idem_002', type: 'invoice.payment_succeeded', data: { object: invoice } };

      // 冪等INSERTが ON CONFLICT に当たった状態（rowCount: 0）＝ 既に処理済み
      const dedupDb = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };

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
      // dedup INSERT の1回だけが呼ばれ、payment_succeeded の billing_status 更新クエリは呼ばれない
      expect(dedupDb.query).toHaveBeenCalledTimes(1);
      expect(dedupDb.query).not.toHaveBeenCalledWith(
        expect.stringContaining("billing_status = 'paid'"),
        expect.anything()
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: 'evt_idem_002', eventType: 'invoice.payment_succeeded' }),
        expect.any(String)
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
  });
});
