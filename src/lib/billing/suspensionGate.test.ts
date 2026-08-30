// src/lib/billing/suspensionGate.test.ts
// fix/unpaid-suspension [P0]: 提供停止/劣化ゲートの純粋関数 + DBラッパ + 述語のテスト。

import {
  resolveBillingAccess,
  queryBillingAccess,
  blocksPaidFeature,
  blocksTextChat,
  shouldDegradeToFreeAdCap,
  getPastDueGraceDays,
  type BillingStateRow,
} from './suspensionGate';

const NOW = new Date('2026-08-30T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function row(overrides: Partial<BillingStateRow> = {}): BillingStateRow {
  return {
    plan: 'standard',
    subscriptionStatus: 'active',
    subActive: true,
    delinquentSince: null,
    ...overrides,
  };
}

describe('resolveBillingAccess', () => {
  it('健全な有料テナント(active)は active', () => {
    expect(resolveBillingAccess(row(), NOW, 7)).toBe('active');
  });

  it('free_ad は subscription 状態に関わらず常に active(止める対象が無い)', () => {
    expect(resolveBillingAccess(row({ plan: 'free_ad', subscriptionStatus: 'unpaid', subActive: false }), NOW, 7)).toBe('active');
  });

  it('enterprise は自動停止の対象外(個別契約)', () => {
    expect(resolveBillingAccess(row({ plan: 'enterprise', subscriptionStatus: 'unpaid' }), NOW, 7)).toBe('active');
  });

  it('subscription_status=NULL(migration前の既存テナント)は active に倒す(全顧客一斉停止を避ける)', () => {
    expect(resolveBillingAccess(row({ subscriptionStatus: null, subActive: null }), NOW, 7)).toBe('active');
  });

  it('past_due かつ猶予内は grace(全提供継続)', () => {
    expect(resolveBillingAccess(row({ subscriptionStatus: 'past_due', delinquentSince: daysAgo(3) }), NOW, 7)).toBe('grace');
  });

  it('past_due かつ猶予超過は restricted(劣化)', () => {
    expect(resolveBillingAccess(row({ subscriptionStatus: 'past_due', delinquentSince: daysAgo(10) }), NOW, 7)).toBe('restricted');
  });

  it('past_due で猶予ちょうど(境界=超過していない)は grace', () => {
    // delinquent from exactly 7 days ago: now - since == graceMs, not strictly greater → grace
    expect(resolveBillingAccess(row({ subscriptionStatus: 'past_due', delinquentSince: daysAgo(7) }), NOW, 7)).toBe('grace');
  });

  it('past_due だが delinquent_since が無い異常系は grace(起点直後扱い)', () => {
    expect(resolveBillingAccess(row({ subscriptionStatus: 'past_due', delinquentSince: null }), NOW, 7)).toBe('grace');
  });

  it('unpaid は suspended(dunning撃ち尽くし)', () => {
    expect(resolveBillingAccess(row({ subscriptionStatus: 'unpaid' }), NOW, 7)).toBe('suspended');
  });

  it('canceled は suspended', () => {
    expect(resolveBillingAccess(row({ subscriptionStatus: 'canceled' }), NOW, 7)).toBe('suspended');
  });

  it('subscription.deleted 相当(sub_active=false)は status に関わらず suspended', () => {
    expect(resolveBillingAccess(row({ subscriptionStatus: 'active', subActive: false }), NOW, 7)).toBe('suspended');
  });

  it('有料プランで stripe_subscriptions 行が無い(sub_active=null)は suspended にしない(決済未設定の正常導線)', () => {
    expect(resolveBillingAccess(row({ subscriptionStatus: null, subActive: null }), NOW, 7)).toBe('active');
  });

  it('文字列の delinquent_since も解釈できる', () => {
    expect(resolveBillingAccess(row({ subscriptionStatus: 'past_due', delinquentSince: daysAgo(10).toISOString() }), NOW, 7)).toBe('restricted');
  });

  it('active 復帰で解除(restricted→active)', () => {
    expect(resolveBillingAccess(row({ subscriptionStatus: 'active', delinquentSince: null }), NOW, 7)).toBe('active');
  });
});

describe('述語(fail-safe の向き)', () => {
  it('blocksPaidFeature: restricted / suspended で true、null(判定不能)も true(原価保護=fail-closed)', () => {
    expect(blocksPaidFeature('active')).toBe(false);
    expect(blocksPaidFeature('grace')).toBe(false);
    expect(blocksPaidFeature('restricted')).toBe(true);
    expect(blocksPaidFeature('suspended')).toBe(true);
    expect(blocksPaidFeature(null)).toBe(true);
  });

  it('blocksTextChat: suspended のみ true、null(判定不能)は false(可用性優先=fail-open)', () => {
    expect(blocksTextChat('active')).toBe(false);
    expect(blocksTextChat('grace')).toBe(false);
    expect(blocksTextChat('restricted')).toBe(false);
    expect(blocksTextChat('suspended')).toBe(true);
    expect(blocksTextChat(null)).toBe(false);
  });

  it('shouldDegradeToFreeAdCap: restricted のみ true', () => {
    expect(shouldDegradeToFreeAdCap('restricted')).toBe(true);
    expect(shouldDegradeToFreeAdCap('suspended')).toBe(false);
    expect(shouldDegradeToFreeAdCap('grace')).toBe(false);
    expect(shouldDegradeToFreeAdCap(null)).toBe(false);
  });
});

describe('getPastDueGraceDays', () => {
  afterEach(() => { delete process.env.BILLING_PAST_DUE_GRACE_DAYS; });

  it('未設定は既定7日', () => {
    expect(getPastDueGraceDays()).toBe(7);
  });
  it('env の整数を採用', () => {
    process.env.BILLING_PAST_DUE_GRACE_DAYS = '3';
    expect(getPastDueGraceDays()).toBe(3);
  });
  it('不正値(負・NaN)は既定へ倒す', () => {
    process.env.BILLING_PAST_DUE_GRACE_DAYS = '-1';
    expect(getPastDueGraceDays()).toBe(7);
    process.env.BILLING_PAST_DUE_GRACE_DAYS = 'abc';
    expect(getPastDueGraceDays()).toBe(7);
  });
});

describe('queryBillingAccess (DBラッパ)', () => {
  function poolWith(handler: (sql: string, params: unknown[]) => any) {
    return { query: jest.fn().mockImplementation((sql: string, params: unknown[] = []) => Promise.resolve(handler(sql, params))) };
  }

  it('JOIN 結果からアクセス段を算出する(unpaid→suspended)', async () => {
    const pool = poolWith(() => ({ rows: [{ plan: 'growth', subscription_status: 'unpaid', delinquent_since: null, sub_active: true }] }));
    expect(await queryBillingAccess(pool as any, 'tenant-1', NOW)).toBe('suspended');
  });

  it('past_due 猶予超過は restricted', async () => {
    const pool = poolWith(() => ({ rows: [{ plan: 'standard', subscription_status: 'past_due', delinquent_since: daysAgo(30), sub_active: true }] }));
    expect(await queryBillingAccess(pool as any, 'tenant-1', NOW)).toBe('restricted');
  });

  it('テナント不在は active(他層で弾く。ここで止めない)', async () => {
    const pool = poolWith(() => ({ rows: [] }));
    expect(await queryBillingAccess(pool as any, 'nope', NOW)).toBe('active');
  });

  it('42703(migration未適用)は fail-open で active', async () => {
    const pool = { query: jest.fn().mockRejectedValue(Object.assign(new Error('no column'), { code: '42703' })) };
    expect(await queryBillingAccess(pool as any, 'tenant-1', NOW)).toBe('active');
  });

  it('その他のDB例外は null(呼び出し側の述語に fail 方向を委ねる)', async () => {
    const pool = { query: jest.fn().mockRejectedValue(new Error('connection lost')) };
    expect(await queryBillingAccess(pool as any, 'tenant-1', NOW)).toBeNull();
  });
});
