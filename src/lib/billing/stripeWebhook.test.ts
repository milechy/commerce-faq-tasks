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

  describe('冪等性: event.id の重複と並行配信', () => {
    // 処理権の獲得は単一の条件付きUPSERTで行う（INSERT成否を見てから別クエリで
    // 状態をSELECTする方式だと、並行到達した2リクエストが両方「未完了だから再試行」と
    // 判断してハンドラを二重実行しうる。DB更新はWHERE条件付きで冪等だがSlack通知は非冪等）。
    const CLAIM_SQL = 'ON CONFLICT (event_id) DO UPDATE';

    it('処理権の獲得を event.id / event.type / stale閾値 を渡す単一クエリで行う', async () => {
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
        expect.stringContaining(CLAIM_SQL),
        ['evt_idem_001', 'invoice.payment_succeeded', '15']
      );
      // 完了済み/処理中を弾く条件が落ちていないこと（これが無いと二重実行に戻る）
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('completed_at IS NULL'),
        expect.anything()
      );
    });

    it('処理権を獲得できなければ（完了済み or 他リクエストが処理中）副作用をスキップし duplicate:true を返す', async () => {
      const invoice = { id: 'inv_011', subscription: 'sub_idem_002', amount_due: 700 };
      const event = { id: 'evt_idem_002', type: 'invoice.payment_succeeded', data: { object: invoice } };

      // claim の条件付きUPSERTが0行 = 完了済み、または他リクエストが処理中
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
      // claim の1クエリだけ。ハンドラにも completed_at マークにも進まない
      expect(dedupDb.query).toHaveBeenCalledTimes(1);
      expect(dedupDb.query).not.toHaveBeenCalledWith(
        expect.stringContaining("billing_status = 'paid'"),
        expect.anything()
      );
    });

    it('[回帰] 同一event.idが並行到達しても、処理権を獲得した側だけが副作用を実行する（二重通知の防止）', async () => {
      // 実装が claim(条件付きUPSERT) ではなく「INSERT成否 → 別クエリでSELECT」に
      // 戻ると、2つ目も completed_at IS NULL を見て処理してしまいSlack通知が二重に飛ぶ。
      const invoice = { id: 'inv_race', subscription: 'sub_race', amount_due: 1200 };
      const event = { id: 'evt_race_001', type: 'invoice.payment_failed', data: { object: invoice } };

      const raceDb = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ event_id: 'evt_race_001' }] }) // A: claim獲得
          .mockResolvedValueOnce({ rowCount: 1, rows: [] })                              // A: completed_atマーク
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }),                             // B: claim失敗(Aが処理中)
      };

      const stripeMock = require('stripe');
      stripeMock.mockImplementation(() => ({
        webhooks: { constructEvent: jest.fn().mockReturnValue(event) },
      }));

      const handler = createStripeWebhookHandler(raceDb as any, mockLogger);
      const { req: reqA, res: resA } = makeReqRes({
        body: Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });
      const { req: reqB, res: resB } = makeReqRes({
        body: Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(reqA, resA);
      await handler(reqB, resB);

      expect(resA._body).toEqual({ received: true });
      expect(resB._body).toEqual({ received: true, duplicate: true });
      // payment_failed のハンドラ（Slack通知経路）に到達したのはA側の1回だけ
      const failedWarns = (mockLogger.warn as jest.Mock).mock.calls.filter(
        ([arg]) => arg && typeof arg === 'object' && arg.invoiceId === 'inv_race'
      );
      expect(failedWarns).toHaveLength(1);
    });

    it('署名不正の場合は処理権の獲得より前に拒否される（DBに触れない）', async () => {
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

    it('同一event.idが連続で2回配信された場合、1回目は処理され2回目は重複扱いになる', async () => {
      const invoice = { id: 'inv_012', subscription: 'sub_idem_003', amount_due: 300 };
      const event = { id: 'evt_idem_003', type: 'invoice.payment_succeeded', data: { object: invoice } };

      const sequentialDb = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ event_id: 'x' }] }) // #1 claim獲得
          .mockResolvedValueOnce({ rowCount: 5, rows: [] })                  // #1 billing_status更新
          .mockResolvedValueOnce({ rowCount: 1, rows: [] })                  // #1 completed_atマーク
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }),                 // #2 claim失敗(完了済み)
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
      expect(sequentialDb.query).toHaveBeenCalledTimes(4);
    });

    it('[修正確認] ハンドラが失敗しても completed_at が付かないため、stale claim 経過後の再送で副作用が再試行される', async () => {
      // 1回目: claim獲得 → billing_status更新が失敗 → completed_atはマークされない(500)
      // 2回目(再送): 前回claimがstale閾値を過ぎているので再獲得でき、再試行して成功する。
      const invoice = { id: 'inv_013', subscription: 'sub_poison', amount_due: 999 };
      const event = { id: 'evt_poison_001', type: 'invoice.payment_succeeded', data: { object: invoice } };

      const recoveringDb = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ event_id: 'x' }] })  // #1 claim獲得
          .mockRejectedValueOnce(new Error('DB connection lost'))             // #1 billing_status更新: 失敗
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ event_id: 'x' }] })  // #2 claim再獲得(stale)
          .mockResolvedValueOnce({ rowCount: 1, rows: [] })                   // #2 billing_status更新: 成功
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }),                  // #2 completed_atマーク
      };

      const stripeMock = require('stripe');
      stripeMock.mockImplementation(() => ({
        webhooks: { constructEvent: jest.fn().mockReturnValue(event) },
      }));

      const handler = createStripeWebhookHandler(recoveringDb as any, mockLogger);

      const { req: req1, res: res1 } = makeReqRes({
        body: Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });
      await handler(req1, res1);
      expect(res1._status).toBe(500);

      const { req: req2, res: res2 } = makeReqRes({
        body: Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });
      await handler(req2, res2);
      expect(res2._status).toBe(200);
      expect(res2._body).toEqual({ received: true });

      const billingUpdateCalls = recoveringDb.query.mock.calls.filter(([sql]) =>
        typeof sql === 'string' && sql.includes("billing_status = 'paid'")
      );
      expect(billingUpdateCalls).toHaveLength(2); // 1回目(失敗)・2回目(成功)の両方試行された
      const markCompletedCalls = recoveringDb.query.mock.calls.filter(([sql]) =>
        typeof sql === 'string' && sql.includes('SET completed_at')
      );
      expect(markCompletedCalls).toHaveLength(1); // 成功した2回目のみマークされる
    });

    it('completed_atマーク自体がDB断で失敗した場合、500を返して再送に委ねる（副作用は実行済みなので再試行で重複しうることを明示的に固定）', async () => {
      const invoice = { id: 'inv_015', subscription: 'sub_markfail', amount_due: 450 };
      const event = { id: 'evt_markfail_001', type: 'invoice.payment_succeeded', data: { object: invoice } };

      const markFailDb = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ event_id: 'x' }] }) // claim獲得
          .mockResolvedValueOnce({ rowCount: 1, rows: [] })                  // billing_status更新: 成功
          .mockRejectedValueOnce(new Error('DB connection lost')),           // completed_atマーク: 失敗
      };

      const stripeMock = require('stripe');
      stripeMock.mockImplementationOnce(() => ({
        webhooks: { constructEvent: jest.fn().mockReturnValue(event) },
      }));

      const handler = createStripeWebhookHandler(markFailDb as any, mockLogger);
      const { req, res } = makeReqRes({
        body: Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      // 副作用は成功しているが completed_at が付かないため、Stripeの再送で
      // stale claim 経過後に再実行される（DB更新は冪等、Slack通知は重複しうる）。
      expect(res._status).toBe(500);
      expect(res._body).not.toMatchObject({ received: true });
    });

    it('処理権の獲得クエリ自体がDBエラーで失敗した場合、200を返さずエラーとして扱う', async () => {
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

      expect(res._status).toBe(500);
      expect(res._body).not.toMatchObject({ received: true });
    });

    it('event.id が undefined の異常なイベントでも同期的に例外を投げず、500として扱う', async () => {
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
