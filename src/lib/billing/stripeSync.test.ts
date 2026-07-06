// src/lib/billing/stripeSync.test.ts
// プラン倍率の課金数量算出ロジック検証（Phase2A: リクエスト課金 × プラン別単価）

const mockInvoiceItemsCreate = jest.fn();
const mockSubscriptionsRetrieve = jest.fn();
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    invoiceItems: { create: (...args: unknown[]) => mockInvoiceItemsCreate(...args) },
    subscriptions: { retrieve: (...args: unknown[]) => mockSubscriptionsRetrieve(...args) },
  }));
}, { virtual: true });

import { PLAN_MULTIPLIERS, planMultiplier, lemonsliceShareJpy, monthlyShareJpy, getLemonsliceMonthlyFeeJpy, getLivekitMonthlyFeeJpy, getPlatformMonthlyFeeJpy, chargeOneOffJpy } from './stripeSync';

describe('planMultiplier', () => {
  it('プラン別の倍率を返す（Starter 1.0 / Growth 1.5 / Enterprise 2.5）', () => {
    expect(planMultiplier('starter')).toBe(1.0);
    expect(planMultiplier('growth')).toBe(1.5);
    expect(planMultiplier('enterprise')).toBe(2.5);
  });

  it('null / undefined / 未知のプランは Starter 扱い（1.0）でフォールバック', () => {
    expect(planMultiplier(null)).toBe(1.0);
    expect(planMultiplier(undefined)).toBe(1.0);
    expect(planMultiplier('unknown-plan')).toBe(1.0);
  });

  it('PLAN_MULTIPLIERS は admin-ui PLAN_OPTIONS と同一の3プランを持つ', () => {
    expect(Object.keys(PLAN_MULTIPLIERS).sort()).toEqual(['enterprise', 'growth', 'starter']);
  });
});

describe('billedQuantity 算出（Math.ceil(totalRequests * multiplier)）', () => {
  const billed = (requests: number, plan: string) =>
    Math.ceil(requests * planMultiplier(plan));

  it('Starter は実リクエスト数と一致', () => {
    expect(billed(100, 'starter')).toBe(100);
  });

  it('Growth は 1.5 倍（端数切り上げ）', () => {
    expect(billed(100, 'growth')).toBe(150);
    expect(billed(101, 'growth')).toBe(152); // 151.5 → 152
  });

  it('Enterprise は 2.5 倍', () => {
    expect(billed(100, 'enterprise')).toBe(250);
    expect(billed(3, 'enterprise')).toBe(8); // 7.5 → 8
  });
});

describe('lemonsliceShareJpy（月額固定費の均等割り・切り上げ）', () => {
  it('テナント数で均等割り（切り上げ）', () => {
    expect(lemonsliceShareJpy(1200, 1)).toBe(1200);
    expect(lemonsliceShareJpy(1200, 3)).toBe(400);
    expect(lemonsliceShareJpy(1000, 3)).toBe(334); // 333.3 → 334
  });

  it('fee=0 または テナント数=0 は 0（無効）', () => {
    expect(lemonsliceShareJpy(0, 5)).toBe(0);
    expect(lemonsliceShareJpy(1200, 0)).toBe(0);
  });
});

describe('getLemonsliceMonthlyFeeJpy（デフォルト OFF）', () => {
  const saved = process.env.LEMONSLICE_MONTHLY_FEE_JPY;
  afterEach(() => {
    if (saved === undefined) delete process.env.LEMONSLICE_MONTHLY_FEE_JPY;
    else process.env.LEMONSLICE_MONTHLY_FEE_JPY = saved;
  });

  it('未設定なら 0（按分課金は無効）', () => {
    delete process.env.LEMONSLICE_MONTHLY_FEE_JPY;
    expect(getLemonsliceMonthlyFeeJpy()).toBe(0);
  });

  it('数値を設定すると反映', () => {
    process.env.LEMONSLICE_MONTHLY_FEE_JPY = '1200';
    expect(getLemonsliceMonthlyFeeJpy()).toBe(1200);
  });
});

describe('monthlyShareJpy / lemonsliceShareJpy エイリアス', () => {
  it('lemonsliceShareJpy は monthlyShareJpy と同一実装（後方互換）', () => {
    expect(lemonsliceShareJpy).toBe(monthlyShareJpy);
  });
});

describe('getLivekitMonthlyFeeJpy（LiveKit Ship 月額・デフォルト OFF）', () => {
  const saved = process.env.LIVEKIT_MONTHLY_FEE_JPY;
  afterEach(() => {
    if (saved === undefined) delete process.env.LIVEKIT_MONTHLY_FEE_JPY;
    else process.env.LIVEKIT_MONTHLY_FEE_JPY = saved;
  });

  it('未設定なら 0（按分課金は無効）', () => {
    delete process.env.LIVEKIT_MONTHLY_FEE_JPY;
    expect(getLivekitMonthlyFeeJpy()).toBe(0);
  });

  it('数値を設定すると反映（$50 ≈ ¥7500 を均等割りできる）', () => {
    process.env.LIVEKIT_MONTHLY_FEE_JPY = '7500';
    expect(getLivekitMonthlyFeeJpy()).toBe(7500);
    expect(monthlyShareJpy(getLivekitMonthlyFeeJpy(), 3)).toBe(2500);
  });
});

describe('getPlatformMonthlyFeeJpy（プラットフォーム共通費・全テナント按分・デフォルト OFF）', () => {
  const saved = process.env.PLATFORM_MONTHLY_FEE_JPY;
  afterEach(() => {
    if (saved === undefined) delete process.env.PLATFORM_MONTHLY_FEE_JPY;
    else process.env.PLATFORM_MONTHLY_FEE_JPY = saved;
  });

  it('未設定なら 0（按分課金は無効）', () => {
    delete process.env.PLATFORM_MONTHLY_FEE_JPY;
    expect(getPlatformMonthlyFeeJpy()).toBe(0);
  });

  it('Supabase+Cloudflare+Hetzner+ES の合計を1本で設定し全テナントで割れる', () => {
    process.env.PLATFORM_MONTHLY_FEE_JPY = '30000';
    expect(getPlatformMonthlyFeeJpy()).toBe(30000);
    expect(monthlyShareJpy(getPlatformMonthlyFeeJpy(), 4)).toBe(7500);
  });
});

// GID: option_orders(代行作業)完了時の確定金額がcostCalculatorのModelKey不一致で
// ¥0扱いになっていた不具合の修正。リクエスト数課金(reportUsageToStripe)とは別に、
// 確定JPY額を直接Stripe Invoice Itemとして請求するchargeOneOffJpyの単体テスト。
describe('chargeOneOffJpy（単発JPY請求）', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const mockQuery = jest.fn();
  const mockDb = { query: mockQuery };

  const ACTIVE_TENANT_ROW = { rows: [{ billing_enabled: true, billing_free_from: null, billing_free_until: null }] };
  const ACTIVE_SUBSCRIPTION_ROW = { rows: [{ stripe_subscription_id: 'sub_123' }] };
  const SUBSCRIPTION_WITH_ITEM = {
    items: { data: [{ id: 'si_123' }] },
    customer: 'cus_123',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  });

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  it('amountJpy <= 0 は即falseを返しDB/Stripeに一切触れない', async () => {
    const result = await chargeOneOffJpy(mockDb, mockLogger, {
      tenantId: 't1', amountJpy: 0, description: 'x', idempotencyKey: 'k1',
    });
    expect(result).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockInvoiceItemsCreate).not.toHaveBeenCalled();
  });

  it('billing_enabled=false のテナントは請求しない', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ billing_enabled: false }] });

    const result = await chargeOneOffJpy(mockDb, mockLogger, {
      tenantId: 't1', amountJpy: 8000, description: 'x', idempotencyKey: 'k1',
    });

    expect(result).toBe(false);
    expect(mockInvoiceItemsCreate).not.toHaveBeenCalled();
  });

  it('無料期間中のテナントは請求しない', async () => {
    const now = new Date();
    const freeFrom = new Date(now.getTime() - 86400000).toISOString();
    const freeUntil = new Date(now.getTime() + 86400000).toISOString();
    mockQuery.mockResolvedValueOnce({
      rows: [{ billing_enabled: true, billing_free_from: freeFrom, billing_free_until: freeUntil }],
    });

    const result = await chargeOneOffJpy(mockDb, mockLogger, {
      tenantId: 't1', amountJpy: 8000, description: 'x', idempotencyKey: 'k1',
    });

    expect(result).toBe(false);
    expect(mockInvoiceItemsCreate).not.toHaveBeenCalled();
  });

  it('アクティブなStripe subscriptionが無いテナントは請求しない(customerId不明)', async () => {
    mockQuery
      .mockResolvedValueOnce(ACTIVE_TENANT_ROW)
      .mockResolvedValueOnce({ rows: [] }); // stripe_subscriptions 該当なし

    const result = await chargeOneOffJpy(mockDb, mockLogger, {
      tenantId: 't1', amountJpy: 8000, description: 'x', idempotencyKey: 'k1',
    });

    expect(result).toBe(false);
    expect(mockInvoiceItemsCreate).not.toHaveBeenCalled();
  });

  it('正常系: customer/amount/currency/description/idempotencyKeyを指定してinvoiceItemを作成しtrueを返す', async () => {
    mockQuery
      .mockResolvedValueOnce(ACTIVE_TENANT_ROW)
      .mockResolvedValueOnce(ACTIVE_SUBSCRIPTION_ROW);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(SUBSCRIPTION_WITH_ITEM);
    mockInvoiceItemsCreate.mockResolvedValueOnce({ id: 'ii_123' });

    const result = await chargeOneOffJpy(mockDb, mockLogger, {
      tenantId: 't1', amountJpy: 8000.4, description: '代行作業: FAQ登録', idempotencyKey: 'option-complete:order-1',
    });

    expect(result).toBe(true);
    expect(mockInvoiceItemsCreate).toHaveBeenCalledWith(
      { customer: 'cus_123', amount: 8000, currency: 'jpy', description: '代行作業: FAQ登録' },
      { idempotencyKey: 'option-complete:order-1' },
    );
  });

  it('Stripe API呼び出しが例外を投げた場合はfalseを返す(呼び出し元をクラッシュさせない)', async () => {
    mockQuery
      .mockResolvedValueOnce(ACTIVE_TENANT_ROW)
      .mockResolvedValueOnce(ACTIVE_SUBSCRIPTION_ROW);
    mockSubscriptionsRetrieve.mockResolvedValueOnce(SUBSCRIPTION_WITH_ITEM);
    mockInvoiceItemsCreate.mockRejectedValueOnce(new Error('stripe down'));

    const result = await chargeOneOffJpy(mockDb, mockLogger, {
      tenantId: 't1', amountJpy: 8000, description: 'x', idempotencyKey: 'k1',
    });

    expect(result).toBe(false);
    expect(mockLogger.error).toHaveBeenCalled();
  });
});
