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

import { PLAN_MULTIPLIERS, planMultiplier, lemonsliceShareJpy, monthlyShareJpy, getLemonsliceMonthlyFeeJpy, getLivekitMonthlyFeeJpy, getPlatformMonthlyFeeJpy, chargeOneOffJpy, anamSessionBillableUnits } from './stripeSync';

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
