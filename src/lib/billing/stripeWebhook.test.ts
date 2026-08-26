// src/lib/billing/stripeWebhook.test.ts
// Phase32: Stripe Webhook署名検証・イベント処理テスト
//
// PR-4(2026-08-25収益監査): _handlePaymentSucceeded/_handlePaymentFailed は
// 従来 usage_logs.stripe_subscription_id で突合していたが、この列への書き込みは
// リポジトリ全体で0件のため常に0行更新の恒久 no-op だった。旧テストは
// mockDb.query に渡された SQL 文字列の一致だけを見ており、実際の更新行数を
// 検証していなかったため、この no-op のまま緑が続いていた(禁止51)。
// 本ファイルはパターンマッチ式のDBモック(billingHealthCheck.test.ts / stripeSync.test.ts
// と同じ流儀)に書き換え、更新行数(rowCount)を明示的にアサートする。

import { createStripeWebhookHandler } from './stripeWebhook';

// stripe をモック
// ★{virtual:true}を付けない★ 'stripe' は実在するnpmパッケージ(node_modulesに
// 存在)なので、virtual指定は不要かつ有害。virtualはモジュールが実在しない場合
// 専用のオプションで、実在するモジュールに使うとJestの仮想モックレジストリが
// 実モジュール解決パスと別系統になり、フルスイート実行時に他のテストファイル
// (同じ'stripe'を通常のjest.mockで扱うファイル)と競合して、どちらのモックも
// 効かず実際の'stripe'パッケージが読み込まれる事故を招く(2026-08-26、CI Gate 1で
// tests/phase54/billingDashboard.test.ts が無関係に全滅する形で発覚)。
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    webhooks: {
      constructEvent: jest.fn(),
    },
  }));
});

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

/**
 * パターンマッチ式のDBモック。既定はすべて「健全系」の応答
 * (claim獲得成功・subscription→tenant解決成功・billing_status更新1行・completed_atマーク成功)。
 * 個別テストは overrides で一部だけ差し替える。
 */
function makeDb(overrides: Record<string, (sql: string, params: unknown[]) => unknown> = {}) {
  const merged: Record<string, (sql: string, params: unknown[]) => unknown> = {
    'INSERT INTO stripe_webhook_events': () => ({ rowCount: 1, rows: [{ event_id: 'claimed' }] }),
    'SELECT tenant_id FROM stripe_subscriptions': () => ({ rowCount: 1, rows: [{ tenant_id: 'tenant-1' }] }),
    "billing_status = 'paid'":   () => ({ rowCount: 1, rows: [] }),
    "billing_status = 'failed'": () => ({ rowCount: 1, rows: [] }),
    'SET completed_at':          () => ({ rowCount: 1, rows: [] }),
    'is_active = false':         () => ({ rowCount: 1, rows: [] }),
    ...overrides,
  };
  return {
    query: jest.fn().mockImplementation((sql: string, params: unknown[] = []) => {
      for (const [pattern, handler] of Object.entries(merged)) {
        if (sql.includes(pattern)) return Promise.resolve(handler(sql, params));
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
}

/** period_start/period_end 付きの標準的な invoice オブジェクトを作る。 */
function makeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id:           'inv_001',
    subscription: 'sub_abc123',
    amount_due:   1000,
    period_start: 1748736000, // 2025-06-01T00:00:00Z
    period_end:   1751328000, // 2025-07-01T00:00:00Z
    ...overrides,
  };
}

describe('createStripeWebhookHandler', () => {
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

  function mockConstructEventOnce(event: any) {
    const stripeMock = require('stripe');
    stripeMock.mockImplementationOnce(() => ({
      webhooks: { constructEvent: jest.fn().mockReturnValue(event) },
    }));
  }

  // _handleCheckoutSessionCompleted は代表priceを解決するため getStripeClient() を
  // 再度呼ぶ(署名検証用のクライアントとは別インスタンス)。stripeモックは
  // mockImplementationOnce をFIFOで消費するため、署名検証用の1回に続けてこれを
  // 積む。cancelSpy を渡すと孤児subscriptionキャンセル経路(subscriptions.cancel)も
  // モックできる。
  function mockSubscriptionRetrieveOnce(priceId: string | null, cancelSpy?: jest.Mock) {
    const stripeMock = require('stripe');
    stripeMock.mockImplementationOnce(() => ({
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue(
          priceId === null ? { items: { data: [] } } : { items: { data: [{ price: priceId }] } }
        ),
        cancel: cancelSpy ?? jest.fn().mockResolvedValue({}),
      },
    }));
  }

  it('stripe-signature ヘッダーがない場合は 400 を返す', async () => {
    const db = makeDb();
    const handler = createStripeWebhookHandler(db as any, mockLogger);
    const { req, res } = makeReqRes({ headers: {} });

    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._body).toMatchObject({ error: 'missing_stripe_signature' });
  });

  it('STRIPE_WEBHOOK_SECRET が未設定の場合は 500 を返す', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const db = makeDb();
    const handler = createStripeWebhookHandler(db as any, mockLogger);
    const { req, res } = makeReqRes({ headers: { 'stripe-signature': 'sig_xxx' } });

    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._body).toMatchObject({ error: 'webhook_not_configured' });
  });

  it('署名検証に失敗した場合は 400 を返す', async () => {
    const stripeMock = require('stripe');
    stripeMock.mockImplementationOnce(() => ({
      webhooks: {
        constructEvent: jest.fn().mockImplementation(() => {
          throw new Error('No signatures found matching the expected signature');
        }),
      },
    }));

    const db = makeDb();
    const handler = createStripeWebhookHandler(db as any, mockLogger);
    const { req, res } = makeReqRes({
      body:    Buffer.from('{"type":"test"}'),
      headers: { 'stripe-signature': 'invalid_sig' },
    });

    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._body).toMatchObject({ error: 'invalid_signature' });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  describe('invoice.payment_succeeded', () => {
    it('★本題★ subscription→tenant_id を解決し、実際の更新行数(rowCount)がログに反映される(禁止51: SQL文字列一致だけで緑にしない)', async () => {
      const invoice = makeInvoice();
      const event = { id: 'evt_001', type: 'invoice.payment_succeeded', data: { object: invoice } };
      mockConstructEventOnce(event);

      // 実際に3行が更新されたことをシミュレートする(rowCount=3)。
      // 旧実装(stripe_subscription_id突合)は常にrowCount=0だったため、
      // ここでrowCount>0が返ることそのものが本題の回帰防止になる。
      const db = makeDb({
        "billing_status = 'paid'": () => ({ rowCount: 3, rows: [] }),
      });
      const handler = createStripeWebhookHandler(db as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      expect(res._status).toBe(200);
      expect(res._body).toEqual({ received: true });

      // subscription → tenant_id 解決クエリが実行された
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT tenant_id FROM stripe_subscriptions'),
        ['sub_abc123']
      );
      // usage_logs の更新は tenant_id + 期間で行われる(stripe_subscription_idではない)
      expect(db.query).toHaveBeenCalledWith(
        expect.stringMatching(/billing_status = 'paid'/),
        ['tenant-1', '2025-06-01T00:00:00.000Z', '2025-07-01T00:00:00.000Z']
      );
      // ★更新行数そのものをアサートする★
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1', updatedRows: 3 }),
        '[webhook] payment_succeeded: billing_status → paid'
      );
    });

    it('subscriptionに対応するtenant_idがstripe_subscriptionsに無ければ更新せずwarnする(例外にしない)', async () => {
      const invoice = makeInvoice({ subscription: 'sub_unknown' });
      const event = { id: 'evt_002', type: 'invoice.payment_succeeded', data: { object: invoice } };
      mockConstructEventOnce(event);

      const db = makeDb({
        'SELECT tenant_id FROM stripe_subscriptions': () => ({ rowCount: 0, rows: [] }),
      });
      const handler = createStripeWebhookHandler(db as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      expect(res._status).toBe(200);
      expect(db.query).not.toHaveBeenCalledWith(
        expect.stringMatching(/billing_status = 'paid'/),
        expect.anything()
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ subscriptionId: 'sub_unknown', eventType: 'payment_succeeded' }),
        expect.stringContaining('no tenant found')
      );
    });

    it('invoiceにperiod_start/period_endが無ければ更新せずwarnする(境界値: 突合キーが無いケース)', async () => {
      const invoice = makeInvoice({ period_start: undefined, period_end: undefined });
      const event = { id: 'evt_003', type: 'invoice.payment_succeeded', data: { object: invoice } };
      mockConstructEventOnce(event);

      const db = makeDb();
      const handler = createStripeWebhookHandler(db as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      expect(res._status).toBe(200);
      // subscription検索にすら進まない(先にperiod欠落で弾く)
      expect(db.query).not.toHaveBeenCalledWith(
        expect.stringContaining('SELECT tenant_id FROM stripe_subscriptions'),
        expect.anything()
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'payment_succeeded' }),
        expect.stringContaining('period_start/period_end')
      );
    });

    it('subscriptionIdが無いinvoiceは何も更新せずwarnする', async () => {
      const invoice = makeInvoice({ subscription: undefined });
      const event = { id: 'evt_004', type: 'invoice.payment_succeeded', data: { object: invoice } };
      mockConstructEventOnce(event);

      const db = makeDb();
      const handler = createStripeWebhookHandler(db as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      expect(res._status).toBe(200);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: 'inv_001', eventType: 'payment_succeeded' }),
        expect.stringContaining('no subscription id')
      );
    });

    it('更新対象が0件(既にpaid等)でもエラーにならずrowCount:0がログに残る', async () => {
      const invoice = makeInvoice();
      const event = { id: 'evt_005', type: 'invoice.payment_succeeded', data: { object: invoice } };
      mockConstructEventOnce(event);

      const db = makeDb({
        "billing_status = 'paid'": () => ({ rowCount: 0, rows: [] }),
      });
      const handler = createStripeWebhookHandler(db as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      expect(res._status).toBe(200);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ updatedRows: 0 }),
        '[webhook] payment_succeeded: billing_status → paid'
      );
    });
  });

  describe('invoice.payment_failed', () => {
    it('billing_statusをfailedに更新し、更新行数がログに残る(CHECK制約に定義済みだが従来どこからも書かれていなかった)', async () => {
      const invoice = makeInvoice({ id: 'inv_002', subscription: 'sub_abc456', amount_due: 2000 });
      const event = { id: 'evt_006', type: 'invoice.payment_failed', data: { object: invoice } };
      mockConstructEventOnce(event);

      const db = makeDb({
        "billing_status = 'failed'": () => ({ rowCount: 2, rows: [] }),
      });
      const handler = createStripeWebhookHandler(db as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      expect(res._status).toBe(200);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringMatching(/billing_status = 'failed'/),
        ['tenant-1', '2025-06-01T00:00:00.000Z', '2025-07-01T00:00:00.000Z']
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1', updatedRows: 2 }),
        '[webhook] payment_failed: billing_status → failed'
      );
    });

    it('subscriptionからtenant_idが解決できなくてもSlack通知は送る(通知はDB突合の成否と独立)', async () => {
      const invoice = makeInvoice({ id: 'inv_002', subscription: 'sub_unknown', amount_due: 2000 });
      const event = { id: 'evt_007', type: 'invoice.payment_failed', data: { object: invoice } };
      mockConstructEventOnce(event);

      const db = makeDb({
        'SELECT tenant_id FROM stripe_subscriptions': () => ({ rowCount: 0, rows: [] }),
      });
      const handler = createStripeWebhookHandler(db as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      expect(res._status).toBe(200);
      expect(db.query).not.toHaveBeenCalledWith(
        expect.stringMatching(/billing_status = 'failed'/),
        expect.anything()
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: 'inv_002', subscriptionId: 'sub_unknown' }),
        '[webhook] payment_failed'
      );
    });
  });

  it('customer.subscription.deleted イベントでテナントを非アクティブ化する', async () => {
    const subscription = { id: 'sub_deleted_001' };
    const event = { id: 'evt_003', type: 'customer.subscription.deleted', data: { object: subscription } };
    mockConstructEventOnce(event);

    const db = makeDb();
    const handler = createStripeWebhookHandler(db as any, mockLogger);
    const { req, res } = makeReqRes({
      body:    Buffer.from(JSON.stringify(event)),
      headers: { 'stripe-signature': 'valid_sig' },
    });

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('is_active = false'),
      ['sub_deleted_001']
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'sub_deleted_001' }),
      expect.any(String)
    );
  });

  describe('checkout.session.completed', () => {
    // ★このテストが守っている事故★
    // client_admin セルフサービスの Checkout 完了を webhook で拾い損ねると、
    // カードを登録したテナントの stripe_subscriptions 行が永久に作られず、
    // syncSubscriptionItemsToPlan が「no_subscription」を返し続ける。

    it('mode: subscription かつ metadata.tenant_id ありで stripe_subscriptions へ UPSERT する', async () => {
      const session = {
        id: 'cs_test_1',
        mode: 'subscription',
        customer: 'cus_abc',
        subscription: 'sub_abc',
        metadata: { tenant_id: 'tenant-a' },
      };
      const event = { id: 'evt_checkout_1', type: 'checkout.session.completed', data: { object: session } };
      mockConstructEventOnce(event);
      mockSubscriptionRetrieveOnce('price_growth_base');

      const db = makeDb({
        'INSERT INTO stripe_subscriptions': () => ({ rowCount: 1, rows: [] }),
      });
      const handler = createStripeWebhookHandler(db as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      expect(res._status).toBe(200);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO stripe_subscriptions'),
        ['tenant-a', 'cus_abc', 'sub_abc', 'price_growth_base']
      );
    });

    // 展開済み(オブジェクト)の customer/subscription も文字列と同様に扱える。
    it('customer/subscription がオブジェクトで展開されていても id を取り出す', async () => {
      const session = {
        id: 'cs_test_2',
        mode: 'subscription',
        customer: { id: 'cus_xyz' },
        subscription: { id: 'sub_xyz' },
        metadata: { tenant_id: 'tenant-b' },
      };
      const event = { id: 'evt_checkout_2', type: 'checkout.session.completed', data: { object: session } };
      mockConstructEventOnce(event);
      mockSubscriptionRetrieveOnce('price_growth_base');

      const db = makeDb({
        'INSERT INTO stripe_subscriptions': () => ({ rowCount: 1, rows: [] }),
      });
      const handler = createStripeWebhookHandler(db as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO stripe_subscriptions'),
        ['tenant-b', 'cus_xyz', 'sub_xyz', 'price_growth_base']
      );
    });

    // mode: payment(単発決済)等は対象外。誤ってサブスク行を作らない。
    it('mode が subscription 以外なら何もしない', async () => {
      const session = { id: 'cs_test_3', mode: 'payment', customer: 'cus_abc', metadata: {} };
      const event = { id: 'evt_checkout_3', type: 'checkout.session.completed', data: { object: session } };
      mockConstructEventOnce(event);

      const db = makeDb();
      const handler = createStripeWebhookHandler(db as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      expect(res._status).toBe(200);
      expect(db.query).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO stripe_subscriptions'),
        expect.anything()
      );
    });

    // ★越境事故防止★ metadata.tenant_id が無ければ、どのテナントの支払いか
    // 特定できない。黙ってどこかに紐付けるより、記録せず鳴らす方が安全。
    it('metadata.tenant_id が無ければ記録せずエラーログを出す', async () => {
      const session = { id: 'cs_test_4', mode: 'subscription', customer: 'cus_abc', subscription: 'sub_abc', metadata: {} };
      const event = { id: 'evt_checkout_4', type: 'checkout.session.completed', data: { object: session } };
      mockConstructEventOnce(event);

      const db = makeDb();
      const handler = createStripeWebhookHandler(db as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      expect(res._status).toBe(200);
      expect(db.query).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO stripe_subscriptions'),
        expect.anything()
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'cs_test_4' }),
        expect.any(String)
      );
    });

    // mode が省略されている(undefined)場合。'payment' と明示された場合だけでなく、
    // Stripe の他リソース由来の予期しないペイロード形も安全側(何もしない)に倒す。
    it('mode が省略されていれば何もしない', async () => {
      const session = { id: 'cs_test_5', customer: 'cus_abc', subscription: 'sub_abc', metadata: { tenant_id: 'tenant-a' } };
      const event = { id: 'evt_checkout_5', type: 'checkout.session.completed', data: { object: session } };
      mockConstructEventOnce(event);

      const db = makeDb();
      const handler = createStripeWebhookHandler(db as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      expect(res._status).toBe(200);
      expect(db.query).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO stripe_subscriptions'),
        expect.anything()
      );
    });

    // customer が明示的に null(Stripeの型上は起こり得るフィールド)。
    // "?." の連鎖が undefined へ落ちて欠落判定に正しく合流することを確認する。
    it('customer が null なら記録せずエラーログを出す', async () => {
      const session = { id: 'cs_test_6', mode: 'subscription', customer: null, subscription: 'sub_abc', metadata: { tenant_id: 'tenant-a' } };
      const event = { id: 'evt_checkout_6', type: 'checkout.session.completed', data: { object: session } };
      mockConstructEventOnce(event);

      const db = makeDb();
      const handler = createStripeWebhookHandler(db as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      expect(res._status).toBe(200);
      expect(db.query).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO stripe_subscriptions'),
        expect.anything()
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'cs_test_6', customerId: undefined }),
        expect.any(String)
      );
    });

    // ★イレギュラーな操作: Stripeが同じ実体を異なるevent.idで2回送ってくる★
    // (例: 期限切れ寸前のCheckoutセッションを開き直して再度完了させた等)。
    // event.id が異なるため _claimWebhookEvent の重複排除には引っかからないが、
    // ON CONFLICT(tenant_id)のUPSERTなのでテーブル側は1行のまま安全に上書きされる。
    it('同一テナント・同一subscriptionに対し異なるevent.idで2回配信されても1行に収束する', async () => {
      const session1 = { id: 'cs_test_7a', mode: 'subscription', customer: 'cus_abc', subscription: 'sub_abc', metadata: { tenant_id: 'tenant-a' } };
      const session2 = { id: 'cs_test_7b', mode: 'subscription', customer: 'cus_abc', subscription: 'sub_abc', metadata: { tenant_id: 'tenant-a' } };
      const event1 = { id: 'evt_checkout_7a', type: 'checkout.session.completed', data: { object: session1 } };
      const event2 = { id: 'evt_checkout_7b', type: 'checkout.session.completed', data: { object: session2 } };

      const db = makeDb({ 'INSERT INTO stripe_subscriptions': () => ({ rowCount: 1, rows: [] }) });
      const handler = createStripeWebhookHandler(db as any, mockLogger);

      mockConstructEventOnce(event1);
      mockSubscriptionRetrieveOnce('price_growth_base');
      const { req: req1, res: res1 } = makeReqRes({ body: Buffer.from(JSON.stringify(event1)), headers: { 'stripe-signature': 'valid_sig' } });
      await handler(req1, res1);

      mockConstructEventOnce(event2);
      mockSubscriptionRetrieveOnce('price_growth_base');
      const { req: req2, res: res2 } = makeReqRes({ body: Buffer.from(JSON.stringify(event2)), headers: { 'stripe-signature': 'valid_sig' } });
      await handler(req2, res2);

      expect(res1._status).toBe(200);
      expect(res2._status).toBe(200);
      const insertCalls = db.query.mock.calls.filter(
        ([sql]: [string]) => typeof sql === 'string' && sql.includes('INSERT INTO stripe_subscriptions')
      );
      expect(insertCalls).toHaveLength(2); // 2回とも実行される(ON CONFLICTで1行に収束するのはDB側の責務)
      expect(insertCalls[0][1]).toEqual(['tenant-a', 'cus_abc', 'sub_abc', 'price_growth_base']);
      expect(insertCalls[1][1]).toEqual(['tenant-a', 'cus_abc', 'sub_abc', 'price_growth_base']);
    });

    // ★孤児subscription防止(2026-08-26 レビュー是正)★
    // 別タブに残った古いCheckoutが後で完了し、同一テナントに別のsubscriptionが
    // 作られた場合。無条件上書きだと先のsubscriptionがDBから消えStripe側だけ
    // 課金され続ける。ON CONFLICTのWHERE句が0行更新になり、新しい方をキャンセルする。
    it('既に別のアクティブなsubscriptionが記録済みなら上書きせず、新しい方をキャンセルする', async () => {
      const session = {
        id: 'cs_test_orphan',
        mode: 'subscription',
        customer: 'cus_new',
        subscription: 'sub_new',
        metadata: { tenant_id: 'tenant-a' },
      };
      const event = { id: 'evt_checkout_orphan', type: 'checkout.session.completed', data: { object: session } };
      mockConstructEventOnce(event);
      const cancelSpy = jest.fn().mockResolvedValue({});
      mockSubscriptionRetrieveOnce('price_growth_base', cancelSpy);

      // ON CONFLICTのWHERE句(stripe_subscription_id一致 OR is_active=false)に
      // 合致しない = 既に別のアクティブなsubscriptionが紐づいている状態を再現する。
      const db = makeDb({
        'INSERT INTO stripe_subscriptions': () => ({ rowCount: 0, rows: [] }),
      });
      const handler = createStripeWebhookHandler(db as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      expect(res._status).toBe(200); // 孤児化は防いだが、イベント自体はハンドリング成功
      expect(cancelSpy).toHaveBeenCalledWith('sub_new');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-a', subscriptionId: 'sub_new' }),
        expect.stringContaining('キャンセルする')
      );
    });

    // 代表priceが解決できない(subscriptionにitemが無い等)場合、NULLは絶対に
    // INSERTしない。500で失敗させ、Stripeの5xxリトライに委ねる。
    it('代表priceが解決できなければ記録せず500で失敗させる(NULLをINSERTしない)', async () => {
      const session = {
        id: 'cs_test_no_price',
        mode: 'subscription',
        customer: 'cus_abc',
        subscription: 'sub_abc',
        metadata: { tenant_id: 'tenant-a' },
      };
      const event = { id: 'evt_checkout_no_price', type: 'checkout.session.completed', data: { object: session } };
      mockConstructEventOnce(event);
      mockSubscriptionRetrieveOnce(null); // items.data が空

      const db = makeDb();
      const handler = createStripeWebhookHandler(db as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      expect(res._status).toBe(500);
      expect(db.query).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO stripe_subscriptions'),
        expect.anything()
      );
    });
  });

  describe('冪等性: event.id の重複と並行配信', () => {
    // 処理権の獲得は単一の条件付きUPSERTで行う（INSERT成否を見てから別クエリで
    // 状態をSELECTする方式だと、並行到達した2リクエストが両方「未完了だから再試行」と
    // 判断してハンドラを二重実行しうる。DB更新はWHERE条件付きで冪等だがSlack通知は非冪等）。
    const CLAIM_SQL = 'ON CONFLICT (event_id) DO UPDATE';

    it('処理権の獲得を event.id / event.type / stale閾値 を渡す単一クエリで行う', async () => {
      const invoice = makeInvoice({ id: 'inv_010', subscription: 'sub_idem_001', amount_due: 500 });
      const event = { id: 'evt_idem_001', type: 'invoice.payment_succeeded', data: { object: invoice } };
      mockConstructEventOnce(event);

      const db = makeDb();
      const handler = createStripeWebhookHandler(db as any, mockLogger);
      const { req, res } = makeReqRes({
        body:    Buffer.from(JSON.stringify(event)),
        headers: { 'stripe-signature': 'valid_sig' },
      });

      await handler(req, res);

      expect(res._status).toBe(200);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining(CLAIM_SQL),
        ['evt_idem_001', 'invoice.payment_succeeded', '15']
      );
      // 完了済み/処理中を弾く条件が落ちていないこと（これが無いと二重実行に戻る）
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining('completed_at IS NULL'),
        expect.anything()
      );
    });

    it('処理権を獲得できなければ（完了済み or 他リクエストが処理中）副作用をスキップし duplicate:true を返す', async () => {
      const invoice = makeInvoice({ id: 'inv_011', subscription: 'sub_idem_002', amount_due: 700 });
      const event = { id: 'evt_idem_002', type: 'invoice.payment_succeeded', data: { object: invoice } };
      mockConstructEventOnce(event);

      // claim の条件付きUPSERTが0行 = 完了済み、または他リクエストが処理中
      const dedupDb = makeDb({
        'INSERT INTO stripe_webhook_events': () => ({ rowCount: 0, rows: [] }),
      });

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
        expect.stringMatching(/billing_status = 'paid'/),
        expect.anything()
      );
    });

    it('[回帰] 同一event.idが並行到達しても、処理権を獲得した側だけが副作用を実行する（二重通知の防止）', async () => {
      // 実装が claim(条件付きUPSERT) ではなく「INSERT成否 → 別クエリでSELECT」に
      // 戻ると、2つ目も completed_at IS NULL を見て処理してしまいSlack通知が二重に飛ぶ。
      const invoice = makeInvoice({ id: 'inv_race', subscription: 'sub_race', amount_due: 1200 });
      const event = { id: 'evt_race_001', type: 'invoice.payment_failed', data: { object: invoice } };

      const raceDb = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ event_id: 'evt_race_001' }] }) // A: claim獲得
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ tenant_id: 'tenant-1' }] })    // A: subscription→tenant解決
          .mockResolvedValueOnce({ rowCount: 1, rows: [] })                              // A: billing_status='failed'更新
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
      // payment_failed のハンドラ（Slack通知経路）に到達したのはA側の1回だけ。
      // '[webhook] payment_failed' 本体ログと 'billing_status → failed' ログの
      // 2種類が出るが、いずれもA側のみ・B側では出ないことを見る(msg単位で絞る)。
      const initialFailedWarns = (mockLogger.warn as jest.Mock).mock.calls.filter(
        ([arg, msg]) => arg?.invoiceId === 'inv_race' && msg === '[webhook] payment_failed'
      );
      const statusUpdateWarns = (mockLogger.warn as jest.Mock).mock.calls.filter(
        ([arg, msg]) => arg?.invoiceId === 'inv_race' && msg === '[webhook] payment_failed: billing_status → failed'
      );
      expect(initialFailedWarns).toHaveLength(1);
      expect(statusUpdateWarns).toHaveLength(1);
    });

    it('署名不正の場合は処理権の獲得より前に拒否される（DBに触れない）', async () => {
      const dedupDb = makeDb();
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
      const invoice = makeInvoice({ id: 'inv_012', subscription: 'sub_idem_003', amount_due: 300 });
      const event = { id: 'evt_idem_003', type: 'invoice.payment_succeeded', data: { object: invoice } };

      const sequentialDb = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ event_id: 'x' }] })          // #1 claim獲得
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ tenant_id: 'tenant-1' }] })  // #1 subscription→tenant解決
          .mockResolvedValueOnce({ rowCount: 5, rows: [] })                            // #1 billing_status更新(5行)
          .mockResolvedValueOnce({ rowCount: 1, rows: [] })                            // #1 completed_atマーク
          .mockResolvedValueOnce({ rowCount: 0, rows: [] }),                           // #2 claim失敗(完了済み)
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
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ updatedRows: 5 }),
        '[webhook] payment_succeeded: billing_status → paid'
      );
    });

    it('[修正確認] ハンドラが失敗しても completed_at が付かないため、stale claim 経過後の再送で副作用が再試行される', async () => {
      // 1回目: claim獲得 → subscription解決 → billing_status更新が失敗 → completed_atはマークされない(500)
      // 2回目(再送): 前回claimがstale閾値を過ぎているので再獲得でき、再試行して成功する。
      const invoice = makeInvoice({ id: 'inv_013', subscription: 'sub_poison', amount_due: 999 });
      const event = { id: 'evt_poison_001', type: 'invoice.payment_succeeded', data: { object: invoice } };

      const recoveringDb = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ event_id: 'x' }] })          // #1 claim獲得
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ tenant_id: 'tenant-1' }] })  // #1 subscription→tenant解決
          .mockRejectedValueOnce(new Error('DB connection lost'))                      // #1 billing_status更新: 失敗
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ event_id: 'x' }] })          // #2 claim再獲得(stale)
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ tenant_id: 'tenant-1' }] })  // #2 subscription→tenant解決
          .mockResolvedValueOnce({ rowCount: 1, rows: [] })                            // #2 billing_status更新: 成功
          .mockResolvedValueOnce({ rowCount: 1, rows: [] }),                           // #2 completed_atマーク
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

      // jest の mock.calls は「呼ばれたこと」を記録する(rejectしたかどうかは無関係)ため、
      // 1回目(失敗)・2回目(成功)の両方の呼び出しが記録に残る。
      const billingUpdateCalls = recoveringDb.query.mock.calls.filter(([sql]) =>
        typeof sql === 'string' && /billing_status = 'paid'/.test(sql)
      );
      expect(billingUpdateCalls).toHaveLength(2); // 1回目(失敗して例外)・2回目(成功)の両方が試行された
      const markCompletedCalls = recoveringDb.query.mock.calls.filter(([sql]) =>
        typeof sql === 'string' && sql.includes('SET completed_at')
      );
      expect(markCompletedCalls).toHaveLength(1); // 成功した2回目のみマークされる
    });

    it('completed_atマーク自体がDB断で失敗した場合、500を返して再送に委ねる（副作用は実行済みなので再試行で重複しうることを明示的に固定）', async () => {
      const invoice = makeInvoice({ id: 'inv_015', subscription: 'sub_markfail', amount_due: 450 });
      const event = { id: 'evt_markfail_001', type: 'invoice.payment_succeeded', data: { object: invoice } };

      const markFailDb = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ event_id: 'x' }] })          // claim獲得
          .mockResolvedValueOnce({ rowCount: 1, rows: [{ tenant_id: 'tenant-1' }] })  // subscription→tenant解決
          .mockResolvedValueOnce({ rowCount: 1, rows: [] })                            // billing_status更新: 成功
          .mockRejectedValueOnce(new Error('DB connection lost')),                     // completed_atマーク: 失敗
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
      const invoice = makeInvoice({ id: 'inv_014', subscription: 'sub_dberr', amount_due: 100 });
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
