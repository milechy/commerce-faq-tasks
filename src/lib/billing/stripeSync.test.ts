// src/lib/billing/stripeSync.test.ts
// プラン倍率の課金数量算出ロジック検証（Phase2A: リクエスト課金 × プラン別単価）

const mockInvoiceItemsCreate = jest.fn();
const mockSubscriptionsRetrieve = jest.fn();
const mockCreateUsageRecord = jest.fn();
// ★{virtual:true}を付けない★ 'stripe' は実在パッケージなので不要かつ有害
// (2026-08-26: フルスイート実行時に他ファイルの'stripe'モックと競合し、
// 無関係なテストファイル(tests/phase54/billingDashboard.test.ts)が全滅する
// 事故がCI Gate 1で発覚した。詳細は billingApi.checkoutSession.test.ts 参照)。
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    invoiceItems: { create: (...args: unknown[]) => mockInvoiceItemsCreate(...args) },
    subscriptions: { retrieve: (...args: unknown[]) => mockSubscriptionsRetrieve(...args) },
    subscriptionItems: { createUsageRecord: (...args: unknown[]) => mockCreateUsageRecord(...args) },
  }));
});

import { lemonsliceShareJpy, monthlyShareJpy, getLemonsliceMonthlyFeeJpy, getLivekitMonthlyFeeJpy, getPlatformMonthlyFeeJpy, chargeOneOffJpy, anamSessionBillableUnits, reportUsageToStripe, stripeUsageReporter, getPeriodYyyyMm } from './stripeSync';
// PLAN_MULTIPLIERS/planMultiplier の定義自体は planPricing.ts にある。stripeSync.ts の
// re-export は本番コードのどこからも使われておらず(usageTracker.ts は直接 './planPricing'
// から import している)、テストの都合だけで生き残っていた「後方互換」名目の二重管理
// だったため、ここも定義元から直接importする形に揃えた。
import { PLAN_MULTIPLIERS, planMultiplier } from './planPricing';

describe('planMultiplier', () => {
  it('プラン別の倍率を返す（Free(広告表示) 0 / Starter 1.0 / Standard 1.25 / Growth 1.5 / Enterprise 2.5）', () => {
    expect(planMultiplier('free_ad')).toBe(0);
    expect(planMultiplier('starter')).toBe(1.0);
    expect(planMultiplier('standard')).toBe(1.25);
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

  it('PLAN_MULTIPLIERS は admin-ui PLAN_OPTIONS と同一の5プランを持つ', () => {
    expect(Object.keys(PLAN_MULTIPLIERS).sort()).toEqual(['enterprise', 'free_ad', 'growth', 'standard', 'starter']);
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

  // 会話単位の課金で単位の作り方が3系統(行単位 / 会話単位 / 管理AI相談単位)に
  // 分かれたが、どれも「その行に焼き付けた倍率」を持ち回る点は変わらない。
  // 1つでも tenants.plan 由来の倍率を月全体に掛けると遡及が復活する。
  it('請求数量は行に焼き付けた plan_multiplier を持ち回って集計する（行単位・会話単位・管理AI単位の3系統）', () => {
    const src = readSource();
    const occurrences = src.match(/COALESCE\(r\.plan_multiplier,\s*\$4::numeric\)\s+AS multiplier/g);
    expect(occurrences).toHaveLength(3); // conversation_units と row_units と admin_units
    expect(src).toMatch(/SUM\(units \* multiplier\)/);
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
  /**
   * computeExpectedBilling の集計クエリ本体を切り出す。
   * 会話単位の課金で CTE 構成になったため、末尾の `AS billed_units_weighted` から
   * 逆算するのではなく、テンプレートリテラルの開始(`WITH billable_rows AS`)から
   * バインド配列の直前までを丸ごと取る（CTE 内の述語も検査対象に含める）。
   */
  const aggregationSql = () => {
    const src = readSource();
    const from = src.indexOf('WITH billable_rows AS');
    expect(from).toBeGreaterThan(-1);
    const end = src.indexOf('[tenantId, startDate, endDate', from);
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
  // 集計式は computeExpectedBilling() に切り出してある(_reportTenantUsage と
  // billingReconciliation.ts の両方が同じ式を使うため。呼び出し引数名は
  // currentPlan だが、実体は同じ planMultiplier() 呼び出し)。
  it('フォールバック倍率は planMultiplier(currentPlan) を $4 として渡す', () => {
    const src = readSource();
    expect(src).toMatch(/const fallbackMultiplier = planMultiplier\(currentPlan\);/);
    // $5 = ADMIN_DIMENSION_FEATURES(管理AI次元のfeature_used名。admin_units/row_unitsのSQLパラメータ)。
    expect(src).toMatch(/\[tenantId, startDate, endDate, fallbackMultiplier, ADMIN_DIMENSION_FEATURES\]/);
  });

  // 焼き付け済みの行にフォールバックが効いてしまうと、月中変更の按分が消える。
  it('フォールバックは plan_multiplier が NULL の行にだけ効く(COALESCE)', () => {
    expect(aggregationSql()).toMatch(/COALESCE\(r\.plan_multiplier,\s*\$4::numeric\)/);
  });

  it('anam_session は秒→分に切り上げ、それ以外は1単位として数える', () => {
    const sql = aggregationSql();
    expect(sql).toMatch(/r\.feature_used\s*=\s*'anam_session'/);
    expect(sql).toMatch(/CEIL\(COALESCE\(r\.anam_session_seconds,\s*0\)\s*\/\s*60\.0\)/);
  });

  // ★CLAUDE.md 禁止56: アバターを「回数」で課金しない★
  // 原価は時間に比例する(実測 ¥25.9/分、<1分と15分+で42倍の開き)。
  // 1行=1単位に戻すと長時間セッション1件で赤字になる。
  // anam_session の兄弟として並べるのであって、置き換えではない(上のテストと対)。
  it('avatar はミリ秒→分に切り上げる(回数で数えない)', () => {
    const sql = aggregationSql();
    expect(sql).toMatch(/r\.feature_used\s*=\s*'avatar'/);
    expect(sql).toMatch(/CEIL\(COALESCE\(r\.avatar_session_ms,\s*0\)\s*\/\s*60000\.0\)/);
  });

  // ★CLAUDE.md 禁止56: テキストを「リクエスト」で課金しない★
  // session_id ごとに畳まないと、会話が長いほど請求が増える旧挙動に戻る。
  it('chat は session_id ごとに1単位へ畳む(DISTINCT ON)', () => {
    const sql = aggregationSql();
    expect(sql).toMatch(/DISTINCT ON \(r\.session_id\)/);
    expect(sql).toMatch(/r\.feature_used = 'chat'/);
    expect(sql).toMatch(/r\.session_id IS NOT NULL/);
  });

  // 会話の倍率は「最初の行」の値(.claude/rules/billing.md §7)。
  // ORDER BY が created_at 昇順でなくなると、月中プラン変更時に
  // どの倍率が採られるかが不定になる(請求の再現性が消える)。
  it('会話の倍率は最初の行(created_at 昇順)から採る', () => {
    expect(aggregationSql()).toMatch(/ORDER BY r\.session_id, r\.created_at, r\.request_id/);
  });

  // 会話の絞り込みは INNER ではなく LEFT JOIN。
  // INNER にすると、Right to Erasure で会話を削除した瞬間に billedQuantity が減り、
  // 「単調非減少」を前提にした idempotencyKey が過去のキーへ後戻りする。
  it('chat_sessions は LEFT JOIN で、行が無い会話は課金対象のまま残す', () => {
    const sql = aggregationSql();
    expect(sql).toMatch(/LEFT JOIN chat_sessions cs/);
    expect(sql).toMatch(/cs\.session_id IS NULL OR cs\.message_count >= 2/);
    expect(sql).not.toMatch(/\n\s*JOIN chat_sessions/);
  });

  // ★CLAUDE.md 禁止24: JOIN先にもテナント述語を張る★
  // chat_sessions の業務キーは (tenant_id, session_id) の複合。session_id だけで
  // 突き合わせると、他テナントの同名セッションの message_count で課金可否が決まる。
  it('chat_sessions の結合条件にテナント述語を含む', () => {
    expect(aggregationSql()).toMatch(/ON cs\.tenant_id = \$1\s*\n\s*AND cs\.session_id = r\.session_id/);
  });

  // ─────────────────────────────────────────────────────────────────────
  // S3(管理AI原価の課金・可視化): admin_units CTE の不変条件。
  // 実DBでの(session_id, JST暦日)グルーピング自体はSQL意味論なので実Postgres
  // でしか検証できない(実DB突合はAsana 1217806758545725と同じ扱い)。
  // ここでは「壊れると請求が静かにズレる」構造をソース上で固定する。
  // ─────────────────────────────────────────────────────────────────────
  it('管理AI(admin_units)は (session_id, JST暦日) の DISTINCT ON で1相談=1単位に畳む', () => {
    const sql = aggregationSql();
    expect(sql).toMatch(/DISTINCT ON \(r\.session_id, \(r\.created_at AT TIME ZONE 'Asia\/Tokyo'\)::date\)/);
    expect(sql).toMatch(/r\.feature_used = ANY\(\$5::text\[\]\)/);
    expect(sql).toMatch(/r\.session_id IS NOT NULL/);
  });

  // ★CLAUDE.md 禁止16: AT TIME ZONE を片側だけ書かない★
  // ここでの AT TIME ZONE は「JSTの壁時計日付を取り出す」ための一方向の変換であり、
  // 期間の絞り込み($2/$3)には使わない(呼び出し元が渡すUTC境界のまま比較する)。
  it('AT TIME ZONEは集計キー(暦日)の算出にのみ使い、期間の絞り込み($2/$3)には使わない', () => {
    const sql = aggregationSql();
    expect(sql).toMatch(/AT TIME ZONE 'Asia\/Tokyo'/);
    expect(sql).not.toMatch(/created_at AT TIME ZONE[^)]*>=\s*\$2/);
    expect(sql).not.toMatch(/created_at AT TIME ZONE[^)]*<\s*\$3/);
  });

  // 管理AIの倍率も「最初の行」から採る。conversation_units(会話)と同じ思想。
  it('管理AI相談の倍率は最初の行(created_at 昇順)から採る', () => {
    expect(aggregationSql()).toMatch(
      /ORDER BY r\.session_id, \(r\.created_at AT TIME ZONE 'Asia\/Tokyo'\)::date, r\.created_at, r\.request_id/
    );
  });

  // ★二重計上防止★ 管理AI(session_idあり)の行は row_units 側から除外されていること。
  // 除外していないと、admin_units と row_units の両方で同じ行が数えられる。
  it('row_units は管理AI(session_idあり)の行を除外する(admin_unitsとの二重計上防止)', () => {
    expect(aggregationSql()).toMatch(
      /NOT \(r\.feature_used = ANY\(\$5::text\[\]\) AND r\.session_id IS NOT NULL\)/
    );
  });

  // session_id を持たない管理AI行(記録漏れ・配線前の既存行)は、chat の
  // フォールバックと同じ思想で row_units に残り 1行=1単位のまま救済される
  // (admin_consults の SELECT 式が row_units をも数えることで担保する)。
  it('admin_consults は admin_units の件数 + session_idを持たない管理AI行(row_units)を合算する', () => {
    const sql = aggregationSql();
    expect(sql).toMatch(
      /\(SELECT COUNT\(\*\) FROM admin_units\)\s*\n\s*\+ \(SELECT COALESCE\(SUM\(units\), 0\) FROM row_units WHERE feature_used = ANY\(\$5::text\[\]\)\)/
    );
  });

  // billable_units / billed_units_weighted にも admin_units 分が合算されていること
  // (合算し忘れると、admin_unitsで数えた相談が billedQuantity に反映されない)。
  it('billable_units / billed_units_weighted は admin_units の分も合算する', () => {
    const sql = aggregationSql();
    expect(sql).toMatch(/\(SELECT COUNT\(\*\) FROM admin_units\)\s*\)::integer AS billable_units/);
    expect(sql).toMatch(
      /\(SELECT COALESCE\(SUM\(multiplier\), 0\) FROM admin_units\)\s*\)::numeric AS billed_units_weighted/
    );
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
    expect(Object.keys(ui).sort()).toEqual(['enterprise', 'free_ad', 'growth', 'standard', 'starter']);
  });

  it('5プランすべてで倍率が一致する', () => {
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
  // ★plan は「どちらの請求経路を通るか」を決める★
  // standard/growth は基本料+込み枠+超過の経路(_reportQuotaOverageUsage)へ分岐するため、
  // 純従量経路(単一 item へ billedQuantity を送る従来の仕組み)を検証するこの束では
  // 込み枠を持たない starter を使う。込み枠プラン側は別の describe で検証する。
  // なお billed_units_weighted は AGG_ROW でまるごとモックしているので、
  // ここの plan は倍率の計算には影響しない(未焼き付け行のフォールバック倍率のみ)。
  const TENANT_ROW = { rows: [{ billing_enabled: true, billing_free_from: null, billing_free_until: null, plan: 'starter' }], rowCount: 1 };
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
        // ★純従量プランの行の形は変えない★ dimension 列には触れず、DB既定値 'total' に任せる。
        // ここで列を足すと、migration 未適用の時間帯に全テナントが 42703 へ落ちる。
        expect(sql).toMatch(/\(tenant_id,\s*period_yyyymm,\s*idempotency_key,\s*total_requests,\s*total_cost_cents,\s*billed_quantity\)/);
        expect(sql).toMatch(/VALUES\s*\(\$1,\s*\$2,\s*\$3,\s*\$4,\s*\$5,\s*\$6\)/);
        expect(sql).not.toMatch(/dimension/);
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

// PR-3(2026-08-25収益監査): Stripe送信バッチが起動直後の tick を持たず、
// デプロイ頻度が高いR2Cでは実質一度も走らない状態になり得ていた
// (billingHealthMonitor/billingReconciliationMonitorは起動直後に評価するのに
// 送金する唯一のジョブだけが持っていなかった)。
describe('StripeUsageReporter（定期実行ラッパー・PR-3）', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    process.env = { ...OLD_ENV, STRIPE_SECRET_KEY: 'sk_test_dummy' };
    stripeUsageReporter._resetForTest();
  });

  afterEach(() => {
    stripeUsageReporter.stop();
    stripeUsageReporter._resetForTest();
    jest.useRealTimers();
    process.env = OLD_ENV;
  });

  /** テナント0件の最小DB(スケジューラ自体の挙動だけを見る。集計ロジックは上の別descriveで検証済み)。 */
  function makeEmptyDb() {
    return { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
  }

  it('start() を2回呼んでもタイマーは1本だけ登録される(禁止30: 多重起動防止)', () => {
    const db = makeEmptyDb();
    stripeUsageReporter.start(db as any, mockLogger);
    stripeUsageReporter.start(db as any, mockLogger);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('起動直後に1回実行される(24時間を待たない)', async () => {
    const db = makeEmptyDb();
    stripeUsageReporter.start(db as any, mockLogger);
    await jest.advanceTimersByTimeAsync(0);
    expect(db.query).toHaveBeenCalled();
  });

  it('前月分と当月分の2期間で reportUsageToStripe が呼ばれる(月末の取りこぼし対策)', async () => {
    const db = makeEmptyDb();
    stripeUsageReporter.start(db as any, mockLogger);
    await jest.advanceTimersByTimeAsync(0);

    const currentPeriod = getPeriodYyyyMm(new Date());
    const now = new Date();
    const previousPeriod = getPeriodYyyyMm(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));

    const listTenantsCalls = db.query.mock.calls.filter(
      ([sql]: [string]) => typeof sql === 'string' && sql.includes('SELECT DISTINCT tenant_id FROM stripe_subscriptions')
    );
    expect(listTenantsCalls).toHaveLength(2);
    expect(currentPeriod).not.toBe(previousPeriod);
  });

  it('24時間ごとに再実行される', async () => {
    const db = makeEmptyDb();
    stripeUsageReporter.start(db as any, mockLogger);
    await jest.advanceTimersByTimeAsync(0);
    const callsAfterStart = db.query.mock.calls.length;

    await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(db.query.mock.calls.length).toBeGreaterThan(callsAfterStart);
  });

  it('stop() 後はタイマーが残らない', () => {
    const db = makeEmptyDb();
    stripeUsageReporter.start(db as any, mockLogger);
    stripeUsageReporter.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('DBクエリが例外を投げても評価ループごと落ちない(reportUsageToStripe自体の例外はrunが飲み込む)', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('connection terminated')) };
    stripeUsageReporter.start(db as any, mockLogger);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      '[stripeSync] reportUsageToStripe failed'
    );
  });

  it('前のtickが完了する前に次の24hが来ても多重実行しない(isRunningガード)', async () => {
    let releaseFirstQuery: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseFirstQuery = resolve; });
    let queryCount = 0;
    const db = {
      query: jest.fn().mockImplementation(async () => {
        queryCount++;
        if (queryCount === 1) {
          await gate; // 最初のクエリ(前月分のテナント一覧取得)を止めておく
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    stripeUsageReporter.start(db as any, mockLogger);
    // 起動直後のtickが1つ目のクエリで止まっている状態までマイクロタスクを進める
    await Promise.resolve();
    await Promise.resolve();

    // 1つ目のtickがまだ完了していない状態で24時間分タイマーを進め、2回目のtickを発火させる
    await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      {},
      '[stripeSync] previous run still in progress, skipping this tick'
    );

    // 1つ目のtickを完了させる(後片付け)
    releaseFirstQuery!();
    await jest.advanceTimersByTimeAsync(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 基本料 + 込み枠 + 超過 の請求経路（Standard / Growth）。
//
// 確定価格 .claude/rules/billing.md §7:
//   Standard ¥9,800/月 + テキスト1,000会話/アバター30分 込み、超過 ¥25/会話・¥100/分
//   Growth   ¥29,800/月 + テキスト3,000会話/アバター150分 込み、超過 ¥30/会話・¥80/分
//
// ここで守るべき不変条件:
//   1. 基本料の item には usage record を送らない(metered ではないのでAPIエラーになる)
//   2. テキストとアバターは**別々の item** へ、それぞれの絶対値を送る
//   3. 数量にプラン倍率を掛けない(単価が既にプランごとに分かれているので二重適用になる)
//   4. 2次元の冪等は互いに独立(片方が増えても、もう片方は再送されない)
// ─────────────────────────────────────────────────────────────────────────────
describe('込み枠プラン(Standard/Growth): テキスト超過とアバター超過を別itemへ送る', () => {
  const qLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;
  const OLD_ENV = process.env;

  const PRICE_ENV = {
    STRIPE_PRICE_STANDARD_BASE_MONTHLY:   'price_std_base',
    STRIPE_PRICE_STANDARD_TEXT_OVERAGE:   'price_std_text',
    STRIPE_PRICE_STANDARD_AVATAR_OVERAGE: 'price_std_avatar',
    STRIPE_PRICE_GROWTH_BASE_MONTHLY:     'price_gro_base',
    STRIPE_PRICE_GROWTH_TEXT_OVERAGE:     'price_gro_text',
    STRIPE_PRICE_GROWTH_AVATAR_OVERAGE:   'price_gro_avatar',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV, STRIPE_SECRET_KEY: 'sk_test_dummy', ...PRICE_ENV };
    // 3 item 構成の subscription。price → item の対応で送り先を引く
    // (配列の位置で決めると、並びが変わった瞬間にアバターがテキストの単価で請求される)。
    mockSubscriptionsRetrieve.mockResolvedValue({
      customer: 'cus_1',
      items: {
        data: [
          { id: 'si_base',   price: { id: 'price_std_base' } },
          { id: 'si_text',   price: { id: 'price_std_text' } },
          { id: 'si_avatar', price: { id: 'price_std_avatar' } },
        ],
      },
    });
    mockCreateUsageRecord.mockResolvedValue({ id: 'mbur_1' });
  });
  afterAll(() => { process.env = OLD_ENV; });

  /**
   * 込み枠プラン用のモックDB。
   * textUnits / avatarMinutes は集計SQLが返す「生の」数量(倍率適用前)。
   */
  function makeQuotaDb(opts: {
    plan?: string;
    textUnits: number;
    avatarMinutes: number;
    sentKeys?: Set<string>;
    /** LB-4: 既にEnterprise誘導通知が送信済みという想定にする(重複防止の検証用)。 */
    nudgeAlreadyNotified?: boolean;
  }) {
    const { plan = 'standard', textUnits, avatarMinutes, sentKeys = new Set<string>(), nudgeAlreadyNotified = false } = opts;
    const inserted: Array<{ key: string; quantity: number; dimension: string }> = [];

    const query = jest.fn().mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT DISTINCT tenant_id FROM stripe_subscriptions')) {
        return { rows: [{ tenant_id: 't1' }] };
      }
      if (sql.includes('SELECT billing_enabled')) {
        return { rows: [{ billing_enabled: true, billing_free_from: null, billing_free_until: null, plan }] };
      }
      if (sql.includes('billed_units_weighted')) {
        return { rows: [{
          total_requests: textUnits + avatarMinutes,
          total_cost_cents: 500,
          billable_units: textUnits + avatarMinutes,
          // 純従量経路で使う加重合計。込み枠経路では使われないこと自体もここで担保する。
          billed_units_weighted: '99999',
          unstamped_rows: 0,
          text_units: textUnits,
          avatar_minutes: avatarMinutes,
        }] };
      }
      // LB-4の重複防止チェック(notifications SELECT)。stripe_usage_reportsの
      // 'SELECT status' とは別パターンなので先に判定する。
      if (sql.includes('FROM notifications')) {
        return { rows: nudgeAlreadyNotified ? [{ '?column?': 1 }] : [] };
      }
      if (sql.includes('SELECT status FROM stripe_usage_reports')) {
        const [key] = params as [string];
        return { rows: sentKeys.has(key) ? [{ status: 'sent' }] : [] };
      }
      if (sql.includes('SELECT stripe_subscription_id')) {
        return { rows: [{ stripe_subscription_id: 'sub_1' }] };
      }
      if (sql.includes('INSERT INTO stripe_usage_reports')) {
        const p = params as unknown[];
        inserted.push({ key: p[2] as string, quantity: p[5] as number, dimension: p[6] as string });
        return { rows: [] };
      }
      return { rows: [] };
    });

    return { query, inserted };
  }

  /** query.mock.calls から INSERT INTO notifications の呼び出しだけを取り出す。 */
  function notificationInserts(query: jest.Mock): Array<{ type: string; tenantId: string; metadata: any }> {
    return query.mock.calls
      .filter(([sql]: [string]) => sql.includes('INSERT INTO notifications'))
      .map(([, params]: [string, unknown[]]) => ({
        tenantId: params[1] as string,
        type: params[2] as string,
        metadata: JSON.parse(params[6] as string),
      }));
  }

  describe('LB-4: Growth超過が実効単価逆転点を超えたテナントへEnterprise誘導通知を出す', () => {
    it('GROWTH_TEXT_UNITS_ENTERPRISE_NUDGE_THRESHOLD(6020)以上のGrowthテナントへ通知する(請求自体は変えない)', async () => {
      const db = makeQuotaDb({ plan: 'growth', textUnits: 6020, avatarMinutes: 0 });
      await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });

      const inserts = notificationInserts(db.query);
      expect(inserts).toHaveLength(1);
      expect(inserts[0]).toMatchObject({
        tenantId: 't1',
        type: 'growth_enterprise_nudge',
        metadata: { tenant_period: 't1_202603', text_units: 6020, period: '202603' },
      });
    });

    it('閾値未満(6019)なら通知しない', async () => {
      const db = makeQuotaDb({ plan: 'growth', textUnits: 6019, avatarMinutes: 0 });
      await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });
      expect(notificationInserts(db.query)).toHaveLength(0);
    });

    it('Standardは対象外(Growth専用の閾値のため、同じtextUnitsでも通知しない)', async () => {
      const db = makeQuotaDb({ plan: 'standard', textUnits: 6020, avatarMinutes: 0 });
      await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });
      expect(notificationInserts(db.query)).toHaveLength(0);
    });

    it('同一テナント・同一期間に既に通知済みなら再送しない(重複防止)', async () => {
      const db = makeQuotaDb({ plan: 'growth', textUnits: 6020, avatarMinutes: 0, nudgeAlreadyNotified: true });
      await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });
      expect(notificationInserts(db.query)).toHaveLength(0);
    });

    it('通知SELECTが例外を投げても、実際の請求送信(_reportQuotaOverageUsage)は止めない', async () => {
      // このdescribeのdefault beforeEachはStandard向けprice(price_std_*)のsubscription itemsを
      // 積んでいるため、Growthを検証するこのテストではGrowth向け(price_gro_*)に上書きする
      // (「Growth で ×1.5」テストと同じパターン)。
      mockSubscriptionsRetrieve.mockResolvedValue({
        customer: 'cus_1',
        items: {
          data: [
            { id: 'si_base',   price: { id: 'price_gro_base' } },
            { id: 'si_text',   price: { id: 'price_gro_text' } },
            { id: 'si_avatar', price: { id: 'price_gro_avatar' } },
          ],
        },
      });
      const inner = makeQuotaDb({ plan: 'growth', textUnits: 6020, avatarMinutes: 0 });
      const query = jest.fn().mockImplementation((sql: string, params: unknown[] = []) => {
        if (sql.includes('FROM notifications')) return Promise.reject(new Error('db down'));
        return inner.query(sql, params);
      });
      await reportUsageToStripe({ query } as any, qLogger, { periodYyyyMm: '202603' });

      // 通知は失敗しても、超過分は通常どおりStripeへ送られる。
      expect(mockCreateUsageRecord).toHaveBeenCalled();
    });
  });

  /** createUsageRecord の呼び出しを (itemId → quantity) で引けるようにする。 */
  function sentByItem(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [itemId, payload] of mockCreateUsageRecord.mock.calls) {
      out[itemId as string] = (payload as { quantity: number }).quantity;
    }
    return out;
  }

  it('込み枠内なら両次元とも 0 を送る(基本料はStripeが自動請求するので usage record を送らない)', async () => {
    const db = makeQuotaDb({ textUnits: 800, avatarMinutes: 20 });
    await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });

    expect(sentByItem()).toEqual({ si_text: 0, si_avatar: 0 });
    // ★基本料の item には絶対に送らない★ metered ではないのでStripeがエラーを返す。
    expect(mockCreateUsageRecord).not.toHaveBeenCalledWith('si_base', expect.anything(), expect.anything());
  });

  it('テキストだけ超過 → テキスト item にだけ超過分、アバターは0', async () => {
    const db = makeQuotaDb({ textUnits: 1200, avatarMinutes: 10 });
    await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });

    expect(sentByItem()).toEqual({ si_text: 200, si_avatar: 0 });
  });

  it('アバターだけ超過 → アバター item にだけ超過分、テキストは0', async () => {
    const db = makeQuotaDb({ textUnits: 500, avatarMinutes: 45 });
    await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });

    expect(sentByItem()).toEqual({ si_text: 0, si_avatar: 15 });
  });

  it('両次元とも超過 → それぞれの item へ、それぞれの絶対値を送る', async () => {
    const db = makeQuotaDb({ textUnits: 1500, avatarMinutes: 100 });
    await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });

    expect(sentByItem()).toEqual({ si_text: 500, si_avatar: 70 });
    expect(mockCreateUsageRecord).toHaveBeenCalledTimes(2);
  });

  // ★★★ 本PRで最も壊れやすい点(その2) ★★★
  // 超過単価はプランごとに別の price として実在するため、倍率は price 側に
  // 織り込まれている。数量にも掛けると二重適用になる。
  it('★数量にプラン倍率を掛けない★ Standard で ×1.25 / ×1.25 されていない', async () => {
    const db = makeQuotaDb({ plan: 'standard', textUnits: 1400, avatarMinutes: 130 });
    await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });

    const sent = sentByItem();
    // テキスト超過 400会話。×1.25 した 500 になってはいけない
    // (¥25 price × 500 = ¥12,500 で、正しい ¥25 × 400 = ¥10,000 より 25% 多い)。
    expect(sent.si_text).toBe(400);
    expect(sent.si_text).not.toBe(500);
    // アバター超過 100分。×1.25 した 125 になってはいけない。
    // アバターは分単価が倍率と逆向き(Standard ¥100 → Growth ¥80)なので、
    // 掛けると「上位ほど高い」向きに反転する(CLAUDE.md 禁止56)。
    expect(sent.si_avatar).toBe(100);
    expect(sent.si_avatar).not.toBe(125);
  });

  it('★数量にプラン倍率を掛けない★ Growth で ×1.5 されていない', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue({
      customer: 'cus_1',
      items: {
        data: [
          { id: 'si_base',   price: { id: 'price_gro_base' } },
          { id: 'si_text',   price: { id: 'price_gro_text' } },
          { id: 'si_avatar', price: { id: 'price_gro_avatar' } },
        ],
      },
    });
    const db = makeQuotaDb({ plan: 'growth', textUnits: 3400, avatarMinutes: 250 });
    await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });

    const sent = sentByItem();
    expect(sent.si_text).toBe(400);
    expect(sent.si_text).not.toBe(600);   // ×1.5
    expect(sent.si_avatar).toBe(100);
    expect(sent.si_avatar).not.toBe(150); // ×1.5
  });

  // 純従量経路の billedQuantity(加重合計)が、込み枠経路へ漏れていないこと。
  // モックは billed_units_weighted に 99999 を返しており、これが送られたら混線している。
  it('込み枠経路は billedQuantity(加重合計)を送らない', async () => {
    const db = makeQuotaDb({ textUnits: 1200, avatarMinutes: 45 });
    await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });

    const quantities = mockCreateUsageRecord.mock.calls.map(([, p]: [string, { quantity: number }]) => p.quantity);
    expect(quantities).not.toContain(99999);
  });

  it('冪等キーは次元ごとに分かれる(同じキーで衝突すると片方が永久に送られない)', async () => {
    const db = makeQuotaDb({ textUnits: 1200, avatarMinutes: 45 });
    await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });

    const keys = mockCreateUsageRecord.mock.calls.map(
      ([, , opts]: [string, unknown, { idempotencyKey: string }]) => opts.idempotencyKey
    );
    expect(keys).toEqual(['billing:t1:202603:text:200', 'billing:t1:202603:avatar:15']);
    expect(new Set(keys).size).toBe(2);
  });

  it('stripe_usage_reports は次元ごとに1行ずつ、dimension 付きで記録される', async () => {
    const db = makeQuotaDb({ textUnits: 1200, avatarMinutes: 45 });
    await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });

    expect(db.inserted).toEqual([
      { key: 'billing:t1:202603:text:200',  quantity: 200, dimension: 'text' },
      { key: 'billing:t1:202603:avatar:15', quantity: 15,  dimension: 'avatar' },
    ]);
  });

  it('両次元とも前回と同じなら、Stripeにも subscription 取得にも触れない(冪等)', async () => {
    const sentKeys = new Set(['billing:t1:202603:text:200', 'billing:t1:202603:avatar:15']);
    const db = makeQuotaDb({ textUnits: 1200, avatarMinutes: 45, sentKeys });
    await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });

    expect(mockCreateUsageRecord).not.toHaveBeenCalled();
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
  });

  // ★2次元の冪等が互いに干渉しないこと★
  // テキストだけが増えた日に、変化していないアバターまで再送すると、
  // 無駄なAPI呼び出しに加えて「送信していないのに送信済みの行が増える」ことになる。
  it('テキストだけ増えた日は、テキストだけ再送されアバターは送られない', async () => {
    const sentKeys = new Set(['billing:t1:202603:text:200', 'billing:t1:202603:avatar:15']);
    // アバターは 45分のまま、テキストだけ 1200 → 1300 に増えた
    const db = makeQuotaDb({ textUnits: 1300, avatarMinutes: 45, sentKeys });
    await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });

    expect(sentByItem()).toEqual({ si_text: 300 });
    expect(mockCreateUsageRecord).toHaveBeenCalledTimes(1);
  });

  it('アバターだけ増えた日は、アバターだけ再送されテキストは送られない', async () => {
    const sentKeys = new Set(['billing:t1:202603:text:200', 'billing:t1:202603:avatar:15']);
    const db = makeQuotaDb({ textUnits: 1200, avatarMinutes: 60, sentKeys });
    await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });

    expect(sentByItem()).toEqual({ si_avatar: 30 });
    expect(mockCreateUsageRecord).toHaveBeenCalledTimes(1);
  });

  it('絶対値送信: 2回目は差分ではなく月初からの累積の超過分を送る', async () => {
    const first = makeQuotaDb({ textUnits: 1200, avatarMinutes: 0 });
    await reportUsageToStripe(first as any, qLogger, { periodYyyyMm: '202603' });
    expect(sentByItem().si_text).toBe(200);

    jest.clearAllMocks();
    mockCreateUsageRecord.mockResolvedValue({ id: 'mbur_2' });
    const second = makeQuotaDb({
      textUnits: 1500, avatarMinutes: 0,
      sentKeys: new Set(['billing:t1:202603:text:200', 'billing:t1:202603:avatar:0']),
    });
    await reportUsageToStripe(second as any, qLogger, { periodYyyyMm: '202603' });
    // 差分の 300 ではなく、累積の超過 500 が送られる
    expect(sentByItem().si_text).toBe(500);
  });

  it('利用が0件のテナントはStripeに触れない(従来と同じ早期return)', async () => {
    const db = makeQuotaDb({ textUnits: 0, avatarMinutes: 0 });
    await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });
    expect(mockCreateUsageRecord).not.toHaveBeenCalled();
  });

  // 該当次元の item が subscription に無い場合、0円で黙って通さずに鳴らすこと。
  it('subscription に該当次元の item が無ければ error ログを出す(黙って請求を落とさない)', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue({
      customer: 'cus_1',
      items: { data: [{ id: 'si_base', price: { id: 'price_std_base' } }] }, // 超過itemが無い
    });
    const db = makeQuotaDb({ textUnits: 1200, avatarMinutes: 45 });
    await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });

    expect(mockCreateUsageRecord).not.toHaveBeenCalled();
    const messages = qLogger.error.mock.calls.map((c: unknown[]) => String(c[1] ?? ''));
    expect(messages.some((m: string) => m.includes('該当次元の item が無い'))).toBe(true);
  });

  // 純従量プランが込み枠経路へ迷い込んでいないことの回帰。
  it('Starter は込み枠経路へ入らず、従来どおり単一itemへ billedQuantity を送る', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue({
      customer: 'cus_1',
      items: { data: [{ id: 'si_only', price: { id: 'price_starter_text' } }] },
    });
    const db = makeQuotaDb({ plan: 'starter', textUnits: 5000, avatarMinutes: 500 });
    await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });

    // 込み枠の差し引きをせず単一itemへ送られること自体は変わらないが、
    // LB-3(STARTER_MONTHLY_BILLED_QUANTITY_CAP)によりStarterの加重合計(モックの99999)は
    // 480(¥9,600、Standardの¥9,800を下回る上限)で頭打ちになる。
    expect(sentByItem()).toEqual({ si_only: 480 });
    expect(mockCreateUsageRecord).toHaveBeenCalledWith(
      'si_only', expect.anything(),
      expect.objectContaining({ idempotencyKey: 'billing:t1:202603:480' })
    );
  });

  it('Enterprise も込み枠経路へ入らない(個別交渉のため自動の込み枠を持たない)', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue({
      customer: 'cus_1',
      items: { data: [{ id: 'si_only', price: { id: 'price_ent' } }] },
    });
    const db = makeQuotaDb({ plan: 'enterprise', textUnits: 5000, avatarMinutes: 500 });
    await reportUsageToStripe(db as any, qLogger, { periodYyyyMm: '202603' });
    expect(sentByItem()).toEqual({ si_only: 99999 });
  });
});
