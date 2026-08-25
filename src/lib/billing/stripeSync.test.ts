// src/lib/billing/stripeSync.test.ts
// プラン倍率の課金数量算出ロジック検証（Phase2A: リクエスト課金 × プラン別単価）

const mockInvoiceItemsCreate = jest.fn();
const mockSubscriptionsRetrieve = jest.fn();
const mockCreateUsageRecord = jest.fn();
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    invoiceItems: { create: (...args: unknown[]) => mockInvoiceItemsCreate(...args) },
    subscriptions: { retrieve: (...args: unknown[]) => mockSubscriptionsRetrieve(...args) },
    subscriptionItems: { createUsageRecord: (...args: unknown[]) => mockCreateUsageRecord(...args) },
  }));
}, { virtual: true });

import { PLAN_MULTIPLIERS, planMultiplier, lemonsliceShareJpy, monthlyShareJpy, getLemonsliceMonthlyFeeJpy, getLivekitMonthlyFeeJpy, getPlatformMonthlyFeeJpy, chargeOneOffJpy, anamSessionBillableUnits, reportUsageToStripe } from './stripeSync';

describe('planMultiplier', () => {
  it('プラン別の倍率を返す（Free(広告表示) 0 / Starter 1.0 / Growth 1.5 / Enterprise 2.5）', () => {
    expect(planMultiplier('free_ad')).toBe(0);
    expect(planMultiplier('starter')).toBe(1.0);
    expect(planMultiplier('growth')).toBe(1.5);
    expect(planMultiplier('enterprise')).toBe(2.5);
  });

  // 意図的な非対称性: queryTenantPlan 等のエンタイトルメント判定は fail-safe で
  // 最も制限の強い free_ad へ倒すが、課金倍率の未知時フォールバックは逆に
  // starter(1.0)のまま変更しない。plan不明時に 0 へ倒すと請求漏れ(取りっぱぐれ)の
  // リスクになるため、「機能を隠す」側は最も厳しく、「請求額」側は取りすぎる方向に
  // 倒すのが安全(過剰請求は問い合わせで発覚するが、請求漏れは気づけない)。
  it('null / undefined / 未知のプランは Starter 扱い（1.0）でフォールバックし続ける(free_adへは倒さない)', () => {
    expect(planMultiplier(null)).toBe(1.0);
    expect(planMultiplier(undefined)).toBe(1.0);
    expect(planMultiplier('unknown-plan')).toBe(1.0);
  });

  it('PLAN_MULTIPLIERS は admin-ui PLAN_OPTIONS と同一の4プランを持つ', () => {
    expect(Object.keys(PLAN_MULTIPLIERS).sort()).toEqual(['enterprise', 'free_ad', 'growth', 'starter']);
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

  // Asana 1217759064329998 AC: 「請求数量が0になること」と「usage_logsに原価が
  // 計上されること」は別々にアサートする(前者だけ見ると赤字が不可視のまま通る)。
  it('free_ad は倍率0のため請求数量は常に0（何件使っても課金されない）', () => {
    expect(billed(0, 'free_ad')).toBe(0);
    expect(billed(1, 'free_ad')).toBe(0);
    expect(billed(200, 'free_ad')).toBe(0); // 月次上限いっぱいまで使っても0
  });

  it('free_adの請求数量が0でも、原価(cost_total_cents)の計算はplanを見ないため0にならない', () => {
    // calculateBillingAmountCents(costCalculator.ts)はplan引数を取らない —
    // 倍率(MARGIN_MULTIPLIER)はfeatureUsedのみで決まり、Stripe請求数量とは無関係に
    // 常に計算される。free_adでも「使った」という事実そのものはusage_logsに残る。
    const { calculateBillingAmountCents } = require('./costCalculator') as typeof import('./costCalculator');
    const costCents = calculateBillingAmountCents({
      model: 'gpt-oss-120b',
      inputTokens: 1000,
      outputTokens: 200,
      featureUsed: 'chat',
    });
    expect(costCents).toBeGreaterThan(0);
    // 同時に、この行のStripe請求数量はfree_adなら0
    expect(billed(1, 'free_ad')).toBe(0);
  });
});

// GID 1216944002701788: Anam.aiは$0.16/分の時間課金だが、Stripe報告数量は他機能と同じ
// 「1行=1リクエスト」のままだと3分セッションが1リクエスト分の単価でしか請求されず赤字になる。
// anam_session行のみ秒→分に換算して billable units に加算する（案A: 行数ベースは維持）。
describe('anamSessionBillableUnits（anam_session行の秒→分換算・切り上げ）', () => {
  it('0秒は0（対象外）', () => {
    expect(anamSessionBillableUnits(0)).toBe(0);
  });

  it('59秒は1分に切り上げ', () => {
    expect(anamSessionBillableUnits(59)).toBe(1);
  });

  it('60秒はちょうど1分', () => {
    expect(anamSessionBillableUnits(60)).toBe(1);
  });

  it('61秒は2分に切り上げ', () => {
    expect(anamSessionBillableUnits(61)).toBe(2);
  });

  it('3分(180秒)はちょうど3分', () => {
    expect(anamSessionBillableUnits(180)).toBe(3);
  });

  it('null / undefined / 負値は0', () => {
    expect(anamSessionBillableUnits(null)).toBe(0);
    expect(anamSessionBillableUnits(undefined)).toBe(0);
    expect(anamSessionBillableUnits(-5)).toBe(0);
  });
});

describe('billedQuantity（anam_session混在時の分数換算を加算・後方互換）', () => {
  // stripeSync._reportTenantUsage の集計SQL（billable_units）と同じ規則:
  // billableUnits = 非anam行のCOUNT(*) + anam_session行のΣanamSessionBillableUnits(seconds)
  const billed = (billableUnits: number, plan: string) =>
    Math.ceil(billableUnits * planMultiplier(plan));

  it('テキストのみのテナントは billableUnits === totalRequests のまま（現行と変わらない）', () => {
    const billableUnits = 100; // anam_session行が無いのでCOUNT(*)と一致
    expect(billed(billableUnits, 'starter')).toBe(100);
    expect(billed(billableUnits, 'growth')).toBe(150);
  });

  it('chat 10件 + Anam 3分セッション1件（Starter）: 10 + 3 = 13', () => {
    const billableUnits = 10 + anamSessionBillableUnits(180);
    expect(billed(billableUnits, 'starter')).toBe(13);
  });

  it('chat 0件 + Anam 59秒セッション1件（Growth 1.5倍）: ceil(1 * 1.5) = 2', () => {
    const billableUnits = anamSessionBillableUnits(59);
    expect(billed(billableUnits, 'growth')).toBe(2);
  });

  it('Anam複数セッション(59秒+61秒+180秒)は行ごとに切り上げてから合算: 1+2+3=6', () => {
    const billableUnits =
      anamSessionBillableUnits(59) + anamSessionBillableUnits(61) + anamSessionBillableUnits(180);
    expect(billableUnits).toBe(6);
    expect(billed(billableUnits, 'enterprise')).toBe(15); // 6 * 2.5 = 15
  });
});

// GID 1216944003337186: usage_logs.billable=false（管理系LLM機能・chargeOneOffJpyで
// 既に請求済みのsai_agent）の行はstripeSync._reportTenantUsageの集計SQL
// (`AND billable = true`) で除外される。ここではその集計ロジックをJS側で再現して検証する
// （_reportTenantUsageは非exportのため、SQLと同じ集計規則を純粋関数として再現する）。
describe('billedQuantity（billable=falseの行を除外）', () => {
  interface FakeUsageLogRow {
    feature_used: string;
    anam_session_seconds?: number;
    billable: boolean;
  }

  /** stripeSync._reportTenantUsage の集計SQL（`AND billable = true` + billable_units CASE）と同じ規則 */
  function simulateBillableUnits(rows: FakeUsageLogRow[]): number {
    return rows
      .filter((r) => r.billable)
      .reduce(
        (sum, r) =>
          sum +
          (r.feature_used === 'anam_session'
            ? anamSessionBillableUnits(r.anam_session_seconds ?? 0)
            : 1),
        0,
      );
  }

  it('billable=falseの管理系行(admin_tuning等)・sai_agentはbillableUnitsに含まれない', () => {
    const rows: FakeUsageLogRow[] = [
      { feature_used: 'chat', billable: true },
      { feature_used: 'chat', billable: true },
      { feature_used: 'admin_tuning', billable: false },
      { feature_used: 'admin_ai_assist', billable: false },
      { feature_used: 'sai_agent', billable: false },
    ];
    expect(simulateBillableUnits(rows)).toBe(2);
  });

  it('billable=trueのみのテナントは従来通り全行カウントされる（後方互換）', () => {
    const rows: FakeUsageLogRow[] = [
      { feature_used: 'chat', billable: true },
      { feature_used: 'avatar', billable: true },
      { feature_used: 'premium_avatar_generation', billable: true },
    ];
    expect(simulateBillableUnits(rows)).toBe(3);
  });

  it('billable=false行にanam_session混在時も、非billable分は0として扱われる', () => {
    const rows: FakeUsageLogRow[] = [
      { feature_used: 'anam_session', anam_session_seconds: 180, billable: true }, // 3分
      { feature_used: 'anam_session', anam_session_seconds: 180, billable: false }, // 除外される3分
      { feature_used: 'chat', billable: true },
    ];
    expect(simulateBillableUnits(rows)).toBe(4); // 3(billable anam) + 1(chat)、非billable分は含まれない
  });

  it('全行がbillable=falseなら0（Stripeに何も報告されない）', () => {
    const rows: FakeUsageLogRow[] = [
      { feature_used: 'admin_tuning', billable: false },
      { feature_used: 'admin_option_estimator', billable: false },
    ];
    expect(simulateBillableUnits(rows)).toBe(0);
  });
});

// GID 1216944003337186: マイグレーション後の既存行のデフォルト値検証
// （生SQLテキストの検証。実際のDB適用結果はステージング/本番マイグレーション実行時に確認する）
describe('migration_usage_logs_billable_flag.sql', () => {
  it('billableカラムはNOT NULL DEFAULT trueで追加される（既存行は全てbillable=true扱い）', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const sql = fs.readFileSync(
      path.join(__dirname, 'migration_usage_logs_billable_flag.sql'),
      'utf-8',
    );
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS billable BOOLEAN NOT NULL DEFAULT true/);
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

// ─────────────────────────────────────────────────────────────────────────────
// プラン倍率の遡及適用を封じる変更（migration_usage_logs_plan_snapshot.sql）。
//
// SQL の意味論そのものは実 Postgres でしか検証できないため、ここでは
// 「壊れると請求が静かにズレる不変条件」だけを固定する。
// ─────────────────────────────────────────────────────────────────────────────
describe('migration_usage_logs_plan_snapshot.sql', () => {
  const readSql = () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    return fs.readFileSync(path.join(__dirname, 'migration_usage_logs_plan_snapshot.sql'), 'utf-8');
  };

  it('plan / plan_multiplier の2列を追加する', () => {
    const sql = readSql();
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS plan\s+TEXT/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS plan_multiplier\s+NUMERIC/);
  });

  // ★DEFAULT を置くと「未確定」と「free_ad(x0)」が同じ値になり、
  //   既存行の請求が静かに全額消える（CLAUDE.md 禁止20）。
  it('DEFAULT を持たない（NULL=未確定 と 0=free_ad を区別するため）', () => {
    const sql = readSql();
    expect(sql).not.toMatch(/plan_multiplier\s+NUMERIC\([^)]*\)\s+[^;]*DEFAULT/i);
    expect(sql).not.toMatch(/ADD COLUMN IF NOT EXISTS plan\s+TEXT[^;,]*DEFAULT/i);
  });

  // usage_logs は毎リクエスト書き込まれる。ここで CHECK を張ると、
  // tenants.plan の CHECK 未適用事故（migration_free_ad_plan.sql）と同じことが
  // 起きたときに利用記録そのものが失われ、請求不能になる。
  it('usage_logs 側に plan の CHECK 制約を張らない', () => {
    expect(readSql()).not.toMatch(/CHECK\s*\(\s*plan/i);
  });
});

describe('集計SQL: 倍率は行ごとに適用する（月全体への遡及を禁じる）', () => {
  const readSource = () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    return fs.readFileSync(path.join(__dirname, 'stripeSync.ts'), 'utf-8');
  };

  it('請求数量は usage_logs.plan_multiplier を行ごとに掛けて集計する', () => {
    expect(readSource()).toMatch(/\*\s*COALESCE\(plan_multiplier,\s*\$4::numeric\)/);
  });

  // 回帰の本体: billableUnits（月合計）に tenants.plan の倍率を掛け直すと、
  // 月中のプラン変更が月初まで遡って請求を書き換える状態に戻る。
  it('月合計 billableUnits に現在プランの倍率を掛け直さない', () => {
    expect(readSource()).not.toMatch(/Math\.ceil\(\s*billableUnits\s*\*/);
  });

  it('未焼き付け行が残っていることを検知できるよう unstamped_rows を数える', () => {
    expect(readSource()).toMatch(/COUNT\(\*\) FILTER \(WHERE plan_multiplier IS NULL\)/);
  });
});

describe('billedQuantity（行ごとに倍率が異なる月＝月中プラン変更）', () => {
  /**
   * 新しい集計規則の再現:
   *   billedQuantity = ceil( Σ(row の billable_units × row の倍率) )
   * 旧規則（ceil(Σ billable_units × 現在プランの倍率)）との差がテストの主眼。
   */
  const billedQuantity = (rows: Array<{ units: number; multiplier: number }>) =>
    Math.ceil(rows.reduce((s, r) => s + r.units * r.multiplier, 0));

  it('月初 starter・月末 growth の月は、それぞれの倍率で按分される', () => {
    // 100件を starter(x1.0) で、100件を growth(x1.5) で使った月
    const rows = [
      { units: 100, multiplier: 1.0 },
      { units: 100, multiplier: 1.5 },
    ];
    expect(billedQuantity(rows)).toBe(250);
    // 旧規則なら「現在プラン = growth」が月全体に掛かり 300 になっていた
    expect(billedQuantity(rows)).not.toBe(Math.ceil(200 * 1.5));
  });

  it('月末に free_ad へ落としても、それ以前の利用分は 0 円にならない', () => {
    const rows = [
      { units: 500, multiplier: 2.5 }, // enterprise で1か月使い
      { units: 1, multiplier: 0 },     // 月末に free_ad へ降格した後の1件
    ];
    expect(billedQuantity(rows)).toBe(1250);
    // 旧規則なら「現在プラン = free_ad(x0)」が月全体に掛かり 0 になっていた
    expect(billedQuantity(rows)).not.toBe(0);
  });

  it('月中に上げても、上げる前の利用分まで遡って高くならない', () => {
    const rows = [
      { units: 200, multiplier: 1.0 }, // starter 期間
      { units: 10,  multiplier: 2.5 }, // enterprise へ上げた後
    ];
    expect(billedQuantity(rows)).toBe(225);
    // 旧規則なら 210 件すべてが x2.5 で 525 になっていた（後出しの値上げ）
    expect(billedQuantity(rows)).not.toBe(Math.ceil(210 * 2.5));
  });

  it('切り上げは行ごとではなく合計に対して1回だけ行う', () => {
    // 1件 x1.5 が3行。行ごとに切り上げると 2+2+2=6 に膨らむ。
    const rows = [
      { units: 1, multiplier: 1.5 },
      { units: 1, multiplier: 1.5 },
      { units: 1, multiplier: 1.5 },
    ];
    expect(billedQuantity(rows)).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 集計SQLの不変条件。SQLの意味論は実Postgresでしか検証できないため、
// 「壊れると請求が静かにズレる」条件だけをソース上で固定する。
// (実DBでの突合は Asana 1217806758545725)
// ─────────────────────────────────────────────────────────────────────────────
describe('集計SQL: 絞り込み条件(壊れると請求額が変わる)', () => {
  const readSource = () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    return fs.readFileSync(path.join(__dirname, 'stripeSync.ts'), 'utf-8');
  };
  /** _reportTenantUsage の集計クエリ本体を切り出す */
  const aggregationSql = () => {
    const src = readSource();
    const start = src.indexOf('AS billed_units_weighted');
    expect(start).toBeGreaterThan(-1);
    const from = src.lastIndexOf('SELECT', start);
    const end = src.indexOf('[tenantId, startDate, endDate', start);
    expect(end).toBeGreaterThan(from);
    return src.slice(from, end);
  };

  // ★CLAUDE.md 禁止24: tenant述語のないSQLを書かない★
  // 落とすと全テナントの利用量が1テナントに請求される。
  it('テナント述語を持つ', () => {
    expect(aggregationSql()).toMatch(/WHERE\s+tenant_id\s*=\s*\$1/);
  });

  it('請求期間で半開区間に絞る(月またぎの二重計上を防ぐ)', () => {
    const sql = aggregationSql();
    expect(sql).toMatch(/created_at\s*>=\s*\$2/);
    expect(sql).toMatch(/created_at\s*<\s+\$3/);
    expect(sql).not.toMatch(/created_at\s*<=\s*\$3/); // 終端を含めると翌月分を巻き込む
  });

  // ★C-2: 集計は billing_status で絞らない(月の累積を毎回丸ごと再計算する)★
  // pending 縛りで絞ると、2回目以降の実行が「新たにpendingになった差分」だけを
  // 絶対値としてStripeへ送り、月初からの分を上書きして消してしまう(過少請求)。
  // 冪等性は idempotencyKey に billedQuantity を含めることで担保する
  // (下記 describe('idempotencyKey は billedQuantity を含む') 参照)。
  it('billing_status では絞り込まない(状態遷移に依存させない)', () => {
    expect(aggregationSql()).not.toMatch(/billing_status/);
  });

  // 落とすと、chargeOneOffJpy で請求済みの sai_agent 等を二重請求する。
  it('billable=false の行を除外する', () => {
    expect(aggregationSql()).toMatch(/billable\s*=\s*true/);
  });

  // フォールバック倍率は「現在のテナントのプラン」から作り、$4 で束縛する。
  // 定数に置き換えると、未焼き付け行が誤った単価で請求される。
  it('フォールバック倍率は planMultiplier(plan) を $4 として渡す', () => {
    const src = readSource();
    expect(src).toMatch(/const fallbackMultiplier = planMultiplier\(plan\);/);
    expect(src).toMatch(/\[tenantId, startDate, endDate, fallbackMultiplier\]/);
  });

  // 焼き付け済みの行にフォールバックが効いてしまうと、月中変更の按分が消える。
  it('フォールバックは plan_multiplier が NULL の行にだけ効く(COALESCE)', () => {
    expect(aggregationSql()).toMatch(/COALESCE\(plan_multiplier,\s*\$4::numeric\)/);
  });

  it('anam_session は秒→分に切り上げ、それ以外は1単位として数える', () => {
    const sql = aggregationSql();
    expect(sql).toMatch(/feature_used\s*=\s*'anam_session'/);
    expect(sql).toMatch(/CEIL\(COALESCE\(anam_session_seconds,\s*0\)\s*\/\s*60\.0\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 倍率テーブルの多重定義ドリフト。
// planPricing.ts(請求に使う値) と admin-ui/pages/admin/tenants/types.ts の
// PLAN_OPTIONS(画面に出す値) は独立定義で、既存テストはキー名しか照合していない。
// ズレると「×1.5 と表示して ×2.5 で請求する」状態が全テスト緑のまま作れる。
// admin-ui は別 tsconfig / 別テストランナーなので、ソースを読んで突き合わせる。
// ─────────────────────────────────────────────────────────────────────────────
describe('PLAN_MULTIPLIERS と admin-ui PLAN_OPTIONS の倍率一致', () => {
  /** admin-ui の PLAN_OPTIONS から value→multiplier を抜き出す */
  function readUiMultipliers(): Record<string, number> {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../../admin-ui/src/pages/admin/tenants/types.ts'),
      'utf-8',
    );
    const block = src.slice(src.indexOf('PLAN_OPTIONS'));
    const out: Record<string, number> = {};
    const re = /value:\s*"([a-z_]+)"[^}]*?multiplier:\s*([0-9.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) out[m[1]] = Number(m[2]);
    return out;
  }

  it('抽出できている(正規表現が空振りしていないことの自己検査)', () => {
    const ui = readUiMultipliers();
    expect(Object.keys(ui).sort()).toEqual(['enterprise', 'free_ad', 'growth', 'starter']);
  });

  it('4プランすべてで倍率が一致する', () => {
    const ui = readUiMultipliers();
    for (const [plan, multiplier] of Object.entries(PLAN_MULTIPLIERS)) {
      expect([plan, ui[plan]]).toEqual([plan, multiplier]);
    }
  });
});

describe('planMultiplier の異常入力', () => {
  // Object.prototype 由来のキーで関数が返ると、$4 に関数が束縛されて
  // 集計SQLが壊れる/意図しない値になる。?? 1.0 は null/undefined しか捕まえない。
  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'])(
    'プロトタイプ由来のキー %s でも数値を返す',
    (key) => {
      const v = planMultiplier(key);
      expect(typeof v).toBe('number');
      expect(Number.isFinite(v)).toBe(true);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// reportUsageToStripe / _reportTenantUsage の統合テスト。
//
// これまで stripeSync.test.ts は集計SQLの正規表現照合と、集計規則の再現実装
// (billedQuantity ヘルパ)しか持っておらず、reportUsageToStripe 自体は
// 一度も実行されていなかった(内部の分岐・INSERT/UPDATEの順序・エラー伝播は
// ノーカバーだった)。ここでは実際に呼び出し、モックDBへの実クエリで検証する。
// ─────────────────────────────────────────────────────────────────────────────
describe('reportUsageToStripe（実行される統合テスト）', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV, STRIPE_SECRET_KEY: 'sk_test_dummy' };
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;

  /** SQL断片ごとにハンドラを振り分ける汎用モックDB */
  function makeDb(overrides: Record<string, (sql: string, params: unknown[]) => unknown> = {}) {
    const query = jest.fn().mockImplementation((sql: string, params: unknown[] = []) => {
      for (const [pattern, handler] of Object.entries(overrides)) {
        if (sql.includes(pattern)) return Promise.resolve(handler(sql, params));
      }
      // 未定義パターンは空応答(固定費按分など、この束で興味の無いクエリ用)
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    return { query };
  }

  const ACTIVE_TENANTS = { rows: [{ tenant_id: 't1' }], rowCount: 1 };
  const TENANT_ROW = { rows: [{ billing_enabled: true, billing_free_from: null, billing_free_until: null, plan: 'growth' }], rowCount: 1 };
  const AGG_ROW = (totalRequests: number, billableUnits: number, weighted: string, unstamped = 0) => ({
    rows: [{ total_requests: totalRequests, total_cost_cents: 500, billable_units: billableUnits, billed_units_weighted: weighted, unstamped_rows: unstamped }],
  });
  const SUB_ROW = { rows: [{ stripe_subscription_id: 'sub_1' }], rowCount: 1 };

  beforeEach(() => {
    mockSubscriptionsRetrieve.mockResolvedValue({
      items: { data: [{ id: 'si_1' }] },
      customer: 'cus_1',
    });
    mockCreateUsageRecord.mockResolvedValue({ id: 'mbur_1' });
  });

  it('正常系: 集計→INSERT(billed_quantity込み)→Stripe送信→sent更新→usage_logs更新の順で実行する', async () => {
    const calls: string[] = [];
    const db = makeDb({
      'SELECT DISTINCT tenant_id FROM stripe_subscriptions': () => { calls.push('list_tenants'); return ACTIVE_TENANTS; },
      'SELECT billing_enabled': () => { calls.push('tenant_row'); return TENANT_ROW; },
      'billed_units_weighted': () => { calls.push('aggregate'); return AGG_ROW(150, 150, '225.00'); },
      'SELECT status FROM stripe_usage_reports': () => { calls.push('idempotency_check'); return { rows: [] }; },
      'SELECT stripe_subscription_id': () => { calls.push('sub_lookup'); return SUB_ROW; },
      'INSERT INTO stripe_usage_reports': (sql, params) => {
        calls.push('insert_report');
        // 列リストにも VALUES にも billed_quantity が無いと、6番目の
        // パラメータ(225)が渡っていても DB には書かれない。ここは
        // params だけでなく SQL 文字列側も検証する。
        expect(sql).toMatch(/\(tenant_id,\s*period_yyyymm,\s*idempotency_key,\s*total_requests,\s*total_cost_cents,\s*billed_quantity\)/);
        expect(sql).toMatch(/VALUES\s*\(\$1,\s*\$2,\s*\$3,\s*\$4,\s*\$5,\s*\$6\)/);
        expect(params).toEqual(['t1', expect.any(String), expect.any(String), 150, 500, 225]);
        return { rows: [] };
      },
      'UPDATE stripe_usage_reports': () => { calls.push('mark_sent'); return { rows: [] }; },
      'UPDATE usage_logs': () => { calls.push('mark_reported'); return { rows: [] }; },
    });

    await reportUsageToStripe(db as any, mockLogger, { periodYyyyMm: '202603' });

    expect(mockCreateUsageRecord).toHaveBeenCalledWith(
      'si_1',
      expect.objectContaining({ quantity: 225, action: 'set' }),
      // 冪等キーに金額(225)を含める(C-2)。次回、金額が変わらなければ同じキーで
      // 自然にスキップされ、変われば新しいキーで通る。
      expect.objectContaining({ idempotencyKey: 'billing:t1:202603:225' })
    );
    // 送信前にINSERTしてある(送信が例外を投げても「送ろうとした値」が残る)
    expect(calls.indexOf('insert_report')).toBeLessThan(calls.indexOf('mark_sent'));
    expect(calls).toEqual([
      'list_tenants', 'tenant_row', 'aggregate', 'idempotency_check',
      'sub_lookup', 'insert_report', 'mark_sent', 'mark_reported',
    ]);
  });

  it('既に sent 済みなら再送しない(冪等)', async () => {
    const db = makeDb({
      'SELECT DISTINCT tenant_id FROM stripe_subscriptions': () => ACTIVE_TENANTS,
      'SELECT billing_enabled': () => TENANT_ROW,
      'billed_units_weighted': () => AGG_ROW(150, 150, '225.00'),
      'SELECT status FROM stripe_usage_reports': () => ({ rows: [{ status: 'sent' }] }),
    });
    await reportUsageToStripe(db as any, mockLogger, { periodYyyyMm: '202603' });
    expect(mockCreateUsageRecord).not.toHaveBeenCalled();
  });

  it('利用0件のテナントはStripeに触れない', async () => {
    const db = makeDb({
      'SELECT DISTINCT tenant_id FROM stripe_subscriptions': () => ACTIVE_TENANTS,
      'SELECT billing_enabled': () => TENANT_ROW,
      'billed_units_weighted': () => AGG_ROW(0, 0, '0'),
    });
    await reportUsageToStripe(db as any, mockLogger, { periodYyyyMm: '202603' });
    expect(mockCreateUsageRecord).not.toHaveBeenCalled();
  });

  it('billing_enabled=false のテナントは集計すら行わない', async () => {
    const db = makeDb({
      'SELECT DISTINCT tenant_id FROM stripe_subscriptions': () => ACTIVE_TENANTS,
      'SELECT billing_enabled': () => ({ rows: [{ billing_enabled: false, billing_free_from: null, billing_free_until: null, plan: 'growth' }], rowCount: 1 }),
      'billed_units_weighted': () => { throw new Error('集計SQLに到達してはいけない'); },
    });
    await expect(reportUsageToStripe(db as any, mockLogger, { periodYyyyMm: '202603' })).resolves.toBeUndefined();
    expect(mockCreateUsageRecord).not.toHaveBeenCalled();
  });

  it('無料期間中のテナントは請求しない', async () => {
    const db = makeDb({
      'SELECT DISTINCT tenant_id FROM stripe_subscriptions': () => ACTIVE_TENANTS,
      'SELECT billing_enabled': () => ({
        rows: [{ billing_enabled: true, billing_free_from: '2020-01-01', billing_free_until: '2999-01-01', plan: 'growth' }],
        rowCount: 1,
      }),
      'billed_units_weighted': () => { throw new Error('集計SQLに到達してはいけない'); },
    });
    await reportUsageToStripe(db as any, mockLogger, { periodYyyyMm: '202603' });
    expect(mockCreateUsageRecord).not.toHaveBeenCalled();
  });

  // ★このテストが今回の本題★
  // 42703(migration未適用)は、旧カラム構成へフォールバックして送信を継続し、
  // ループ内の後続テナントを巻き込まないこと。
  it('migration未適用(42703)でも旧カラムで送信を継続し、他テナントを巻き込まない', async () => {
    const insertCalls: string[] = [];
    const db = makeDb({
      'SELECT DISTINCT tenant_id FROM stripe_subscriptions': () => ({ rows: [{ tenant_id: 't1' }, { tenant_id: 't2' }], rowCount: 2 }),
      'SELECT billing_enabled': () => TENANT_ROW,
      'billed_units_weighted': () => AGG_ROW(10, 10, '15.00'),
      'SELECT status FROM stripe_usage_reports': () => ({ rows: [] }),
      'SELECT stripe_subscription_id': () => SUB_ROW,
      'INSERT INTO stripe_usage_reports': (sql: string) => {
        if (sql.includes('billed_quantity')) {
          insertCalls.push('with_billed_quantity');
          const e: any = new Error('column "billed_quantity" of relation "stripe_usage_reports" does not exist');
          e.code = '42703';
          throw e;
        }
        insertCalls.push('legacy');
        return { rows: [] };
      },
    });

    await reportUsageToStripe(db as any, mockLogger, { periodYyyyMm: '202603' });

    // 両テナントとも新カラムで試み→42703→旧カラムで継続、が独立して起きている
    expect(insertCalls).toEqual(['with_billed_quantity', 'legacy', 'with_billed_quantity', 'legacy']);
    // t1 の失敗が t2 の送信を止めていない
    expect(mockCreateUsageRecord).toHaveBeenCalledTimes(2);
  });

  it('42703以外のDBエラーはそのまま投げ、旧カラムへは切り替えない', async () => {
    const db = makeDb({
      'SELECT DISTINCT tenant_id FROM stripe_subscriptions': () => ACTIVE_TENANTS,
      'SELECT billing_enabled': () => TENANT_ROW,
      'billed_units_weighted': () => AGG_ROW(10, 10, '15.00'),
      'SELECT status FROM stripe_usage_reports': () => ({ rows: [] }),
      'SELECT stripe_subscription_id': () => SUB_ROW,
      'INSERT INTO stripe_usage_reports': () => {
        const e: any = new Error('connection terminated');
        e.code = '57P01';
        throw e;
      },
    });
    await expect(reportUsageToStripe(db as any, mockLogger, { periodYyyyMm: '202603' })).rejects.toThrow('connection terminated');
    expect(mockCreateUsageRecord).not.toHaveBeenCalled();
  });

  it('Stripe側が全リトライ失敗しても例外を投げず、failedとして記録する', async () => {
    mockCreateUsageRecord.mockRejectedValue(new Error('Stripe API down'));
    const db = makeDb({
      'SELECT DISTINCT tenant_id FROM stripe_subscriptions': () => ACTIVE_TENANTS,
      'SELECT billing_enabled': () => TENANT_ROW,
      'billed_units_weighted': () => AGG_ROW(10, 10, '15.00'),
      'SELECT status FROM stripe_usage_reports': () => ({ rows: [] }),
      'SELECT stripe_subscription_id': () => SUB_ROW,
    });
    await expect(reportUsageToStripe(db as any, mockLogger, { periodYyyyMm: '202603' })).resolves.toBeUndefined();
  }, 15000);
});

// ─────────────────────────────────────────────────────────────────────────────
// C-2: 累積set方式のリグレッションテスト。
//
// これが今回の本題: 「同月2回目以降のバッチがスキップされ、月初以降の利用が
// 請求されない」(Asana 1217808138968200)を、冪等ガードだけ外す形で直すと、
// 2回目の実行が「新たにpendingになった差分」を絶対値としてStripeへ送り、
// 月初からの分を上書きして消す(過少請求)。ここでは実際に2営業日分の実行を
// シミュレートし、2日目に送られる quantity が「差分」ではなく「累積」で
// あることを、簡易な状態を持つ fake DB で検証する。
// ─────────────────────────────────────────────────────────────────────────────
describe('C-2: 累積set方式（複数回の実行をまたいだ整合性）', () => {
  const cLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV, STRIPE_SECRET_KEY: 'sk_test_dummy' };
    mockSubscriptionsRetrieve.mockResolvedValue({ items: { data: [{ id: 'si_1' }] }, customer: 'cus_1' });
    mockCreateUsageRecord.mockImplementation(async (_itemId: string, params: { quantity: number }) => ({
      id: `mbur_${params.quantity}`,
    }));
  });
  afterAll(() => { process.env = OLD_ENV; });

  /**
   * usage_logs / stripe_usage_reports の最小限の状態を持つ fake DB。
   * SQLパーサは持たず、既知の文パターンだけを判定する(このモジュール内の
   * クエリ形状が変わったら、ここも意図的に直す必要がある=回帰検知として機能する)。
   */
  function makeStatefulDb() {
    const usageLogs: Array<{ id: number; createdAt: string; billable: boolean; billingStatus: string; planMultiplier: number }> = [];
    const usageReports = new Map<string, { status: string; billedQuantity: number }>();
    let nextId = 1;

    function addUsage(n: number, createdAt = '2026-03-15T00:00:00Z') {
      for (let i = 0; i < n; i++) {
        usageLogs.push({ id: nextId++, createdAt, billable: true, billingStatus: 'pending', planMultiplier: 1 });
      }
    }

    const query = jest.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT DISTINCT tenant_id FROM stripe_subscriptions')) {
        return { rows: [{ tenant_id: 't1' }] };
      }
      if (sql.includes('SELECT billing_enabled')) {
        return { rows: [{ billing_enabled: true, billing_free_from: null, billing_free_until: null, plan: 'starter' }] };
      }
      if (sql.includes('billed_units_weighted')) {
        const [, startDate, endDate] = params as [string, string, string];
        const inRange = usageLogs.filter((r) => r.billable && r.createdAt >= startDate && r.createdAt < endDate);
        const total = inRange.length;
        const weighted = inRange.reduce((s, r) => s + r.planMultiplier, 0);
        return { rows: [{ total_requests: total, total_cost_cents: total * 5, billable_units: total, billed_units_weighted: String(weighted), unstamped_rows: 0 }] };
      }
      if (sql.includes('SELECT status FROM stripe_usage_reports')) {
        const [key] = params as [string];
        const found = usageReports.get(key);
        return { rows: found ? [{ status: found.status }] : [] };
      }
      if (sql.includes('SELECT stripe_subscription_id')) {
        return { rows: [{ stripe_subscription_id: 'sub_1' }] };
      }
      if (sql.includes('INSERT INTO stripe_usage_reports')) {
        const key = (params as unknown[])[2] as string;
        const billedQuantity = (params as unknown[])[5] as number;
        usageReports.set(key, { status: 'pending', billedQuantity });
        return { rows: [] };
      }
      if (sql.includes("SET status = 'sent'")) {
        const key = (params as unknown[])[1] as string;
        const existing = usageReports.get(key);
        if (existing) existing.status = 'sent';
        return { rows: [] };
      }
      if (sql.includes('UPDATE usage_logs')) {
        const [, startDate, endDate] = params as [string, string, string];
        for (const r of usageLogs) {
          if (r.billable && r.createdAt >= startDate && r.createdAt < endDate) r.billingStatus = 'reported';
        }
        return { rows: [] };
      }
      return { rows: [] };
    });

    return { query, addUsage, usageLogs, usageReports };
  }

  it('★本題★ 2日目の送信量は「差分」ではなく「月初からの累積」になる', async () => {
    const db = makeStatefulDb();
    db.addUsage(100, '2026-03-01T00:00:00Z'); // 1日目時点の利用

    await reportUsageToStripe(db as any, cLogger, { periodYyyyMm: '202603' });
    expect(mockCreateUsageRecord).toHaveBeenNthCalledWith(
      1, 'si_1', expect.objectContaining({ quantity: 100 }), expect.anything()
    );

    db.addUsage(50, '2026-03-15T00:00:00Z'); // 2日目に新たに発生した利用
    await reportUsageToStripe(db as any, cLogger, { periodYyyyMm: '202603' });

    // ★ここが過少請求バグの検出点★ 50(差分)ではなく150(累積)が送られること。
    expect(mockCreateUsageRecord).toHaveBeenNthCalledWith(
      2, 'si_1', expect.objectContaining({ quantity: 150 }), expect.anything()
    );
    expect(mockCreateUsageRecord).toHaveBeenCalledTimes(2);
  });

  it('変化が無い日は再送しない(冪等キーが金額に紐づく)', async () => {
    const db = makeStatefulDb();
    db.addUsage(100, '2026-03-01T00:00:00Z');

    await reportUsageToStripe(db as any, cLogger, { periodYyyyMm: '202603' });
    await reportUsageToStripe(db as any, cLogger, { periodYyyyMm: '202603' }); // 3日目、利用量は変わらない

    expect(mockCreateUsageRecord).toHaveBeenCalledTimes(1); // 2回目は同額なのでスキップ
  });

  it('3日連続で増え続けても、常に累積が送られる', async () => {
    const db = makeStatefulDb();
    db.addUsage(10, '2026-03-01T00:00:00Z');
    await reportUsageToStripe(db as any, cLogger, { periodYyyyMm: '202603' });

    db.addUsage(10, '2026-03-02T00:00:00Z');
    await reportUsageToStripe(db as any, cLogger, { periodYyyyMm: '202603' });

    db.addUsage(10, '2026-03-03T00:00:00Z');
    await reportUsageToStripe(db as any, cLogger, { periodYyyyMm: '202603' });

    const quantities = mockCreateUsageRecord.mock.calls.map(([, p]: [string, { quantity: number }]) => p.quantity);
    expect(quantities).toEqual([10, 20, 30]); // 差分の[10,10,10]にはならない
  });

  it('減ったふりをして戻ってきても(実際には発生しえないが)累積は単調非減少', async () => {
    // usage_logs は追記専用(削除も更新も無い)ため、集計は本来 非減少 のはず。
    // ここでは「行が増えるだけ」という前提そのものを固定する回帰テスト。
    const db = makeStatefulDb();
    db.addUsage(5);
    await reportUsageToStripe(db as any, cLogger, { periodYyyyMm: '202603' });
    const first = mockCreateUsageRecord.mock.calls[0][1].quantity;

    db.addUsage(3);
    await reportUsageToStripe(db as any, cLogger, { periodYyyyMm: '202603' });
    const second = mockCreateUsageRecord.mock.calls[1][1].quantity;

    expect(second).toBeGreaterThanOrEqual(first);
  });
});
