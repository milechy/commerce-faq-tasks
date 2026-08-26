// src/lib/billing/planPricing.test.ts
// プラン倍率（請求数量に乗じる係数）のテスト。
//
// ★fail-safe の向きが planFeatures.ts と逆であることを固定するのが主目的★
// 機能ゲートは「未知 → 最も制限の強い free_ad」、請求は「未知 → starter 1.0」。
// 取り違えると DB 障害時に請求が 0 円で固着する（CLAUDE.md 禁止37 / rules/billing.md §4）。

import { PLAN_MULTIPLIERS, planMultiplier, getSubscriptionItemPrices, toSubscriptionItems } from "./planPricing";

describe("PLAN_MULTIPLIERS", () => {
  it.each([
    ["free_ad", 0],
    ["starter", 1.0],
    ["standard", 1.25],
    ["growth", 1.5],
    ["enterprise", 2.5],
  ])("%s の倍率は %s", (plan, expected) => {
    expect(planMultiplier(plan)).toBe(expected);
  });

  // .claude/rules/billing.md §7: テキスト超過は ¥20 →(×1.25) ¥25 →(×1.5) ¥30。
  // 倍率が確定価格表と整合していることを、単価の実額まで含めて固定する
  // （倍率だけ見ていると 1.25 を 1.2 に丸めても気づけない）。
  it("テキスト超過単価が確定価格(¥20/¥25/¥30)と倍率どおりに一致する", () => {
    const BASE_TEXT_PRICE_JPY = 20;
    expect(BASE_TEXT_PRICE_JPY * planMultiplier("starter")).toBe(20);
    expect(BASE_TEXT_PRICE_JPY * planMultiplier("standard")).toBe(25);
    expect(BASE_TEXT_PRICE_JPY * planMultiplier("growth")).toBe(30);
  });

  // CLAUDE.md 禁止56 / rules/billing.md §7: アバターの分単価は
  // Standard ¥100 → Growth ¥80 と倍率とは逆向きに下がる。
  // 倍率から算出すると必ず向きが反転するため、「掛けてはいけない」ことを
  // テストとして残す（次に触る人が PLAN_MULTIPLIERS を分単価に流用しないように）。
  it("アバターの分単価は倍率と逆向きなので、倍率をそのまま掛けて算出できない", () => {
    const STANDARD_AVATAR_PRICE_PER_MIN_JPY = 100;
    const GROWTH_AVATAR_PRICE_PER_MIN_JPY = 80;

    // 実際の確定価格は上位プランほど安い
    expect(GROWTH_AVATAR_PRICE_PER_MIN_JPY).toBeLessThan(STANDARD_AVATAR_PRICE_PER_MIN_JPY);
    // 一方、倍率は上位プランほど大きい（＝掛け算では再現できない）
    expect(planMultiplier("growth")).toBeGreaterThan(planMultiplier("standard"));
  });
});

describe("planMultiplier の fail-safe（請求漏れ回避方向）", () => {
  it("未知のプラン文字列は starter 相当の 1.0（0 に落として請求を消さない）", () => {
    expect(planMultiplier("typo-plan")).toBe(1.0);
    expect(planMultiplier("Standard")).toBe(1.0);
  });

  it("null / undefined は starter 1.0", () => {
    expect(planMultiplier(null)).toBe(1.0);
    expect(planMultiplier(undefined)).toBe(1.0);
  });

  it("free_ad の 0 は 1.0 にすり替わらない(?? が 0 を捕まえない性質の回帰)", () => {
    expect(planMultiplier("free_ad")).toBe(0);
  });

  it("Object.prototype 由来のキーは自前プロパティでないため 1.0 に落ちる", () => {
    expect(planMultiplier("constructor")).toBe(1.0);
    expect(planMultiplier("hasOwnProperty")).toBe(1.0);
    expect(planMultiplier("toString")).toBe(1.0);
  });

  it("standard を足しても hasOwnProperty ガードは全キーに効いている", () => {
    for (const key of Object.keys(PLAN_MULTIPLIERS)) {
      expect(planMultiplier(key)).toBe(PLAN_MULTIPLIERS[key]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// プラン → Stripe subscription item の price 構成。
// billingApi.ts(items を作る側)と stripeSync.ts(数量の送り先を決める側)が
// 同じこの関数を通すことで、「作った item と送り先が食い違う」事故を防ぐ。
// ─────────────────────────────────────────────────────────────────────────────
describe('getSubscriptionItemPrices', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      STRIPE_PRICE_STARTER_TEXT:            'price_starter_text',
      STRIPE_PRICE_STANDARD_BASE_MONTHLY:   'price_std_base_m',
      STRIPE_PRICE_STANDARD_BASE_ANNUAL:    'price_std_base_y',
      STRIPE_PRICE_STANDARD_TEXT_OVERAGE:   'price_std_text',
      STRIPE_PRICE_STANDARD_AVATAR_OVERAGE: 'price_std_avatar',
      STRIPE_PRICE_GROWTH_BASE_MONTHLY:     'price_gro_base_m',
      STRIPE_PRICE_GROWTH_BASE_ANNUAL:      'price_gro_base_y',
      STRIPE_PRICE_GROWTH_TEXT_OVERAGE:     'price_gro_text',
      STRIPE_PRICE_GROWTH_AVATAR_OVERAGE:   'price_gro_avatar',
    };
    delete process.env.STRIPE_METERED_PRICE_ID;
  });
  afterAll(() => { process.env = OLD_ENV; });

  it('Standard(月払い) は 基本料 + テキスト超過 + アバター超過 の3本', () => {
    const r = getSubscriptionItemPrices('standard', 'monthly');
    expect(r).toEqual({
      ok: true,
      prices: { base: 'price_std_base_m', text: 'price_std_text', avatarOverage: 'price_std_avatar' },
    });
    expect(toSubscriptionItems((r as any).prices)).toEqual([
      { price: 'price_std_base_m' }, { price: 'price_std_text' }, { price: 'price_std_avatar' },
    ]);
  });

  // ★2026-08-26 実地確認: Stripeは1subscription内の全priceが同じrecurring.intervalで
  // あることを要求する(pin済みapiVersion '2024-06-20'・flexible billing mode未使用時)。
  // 年払い基本料(interval=year)と超過2本(interval=month、年次variant無し)を
  // 混在させるとStripe test-modeで実際にinvalid_request_errorになることを確認した。
  // 恒久対応(flexible billing modeへの全社apiVersion移行、または年払い基本料を
  // 単発invoiceItemsで請求する設計)ができるまで、年払いは自動オンボーディングでは
  // 一律ブロックする(黙って月払い契約になる方が「年払いを選んだのに違う」という
  // 事故になるため、明示的にfalseを返す)。
  it('Standard/Growth の年払いは現状ブロックする(Stripeのinterval混在制約のため)', () => {
    expect(getSubscriptionItemPrices('standard', 'annual')).toEqual({
      ok: false, reason: 'billing_cycle_not_supported',
    });
    expect(getSubscriptionItemPrices('growth', 'annual')).toEqual({
      ok: false, reason: 'billing_cycle_not_supported',
    });
  });

  it('Growth も同じ3本構成で、Growth 専用の price を引く(月払い)', () => {
    expect(getSubscriptionItemPrices('growth', 'monthly')).toEqual({
      ok: true,
      prices: { base: 'price_gro_base_m', text: 'price_gro_text', avatarOverage: 'price_gro_avatar' },
    });
  });

  // Standard と Growth の price が混ざると、片方のプランがもう片方の単価で請求される。
  it('Standard と Growth で同じ price を返さない', () => {
    const std = (getSubscriptionItemPrices('standard', 'monthly') as any).prices;
    const gro = (getSubscriptionItemPrices('growth', 'monthly') as any).prices;
    expect(std.base).not.toBe(gro.base);
    expect(std.text).not.toBe(gro.text);
    expect(std.avatarOverage).not.toBe(gro.avatarOverage);
  });

  it('Starter は基本料を持たず、テキスト従量 1本だけ(1単位目から課金)', () => {
    const r = getSubscriptionItemPrices('starter', 'monthly');
    expect(r).toEqual({ ok: true, prices: { text: 'price_starter_text' } });
    expect(toSubscriptionItems((r as any).prices)).toEqual([{ price: 'price_starter_text' }]);
  });

  it('未知プラン / null は Starter へ倒す(請求漏れより取りすぎを選ぶ既存の fail-safe と同じ向き)', () => {
    expect(getSubscriptionItemPrices('unknown-plan')).toEqual({ ok: true, prices: { text: 'price_starter_text' } });
    expect(getSubscriptionItemPrices(null)).toEqual({ ok: true, prices: { text: 'price_starter_text' } });
    expect(getSubscriptionItemPrices(undefined)).toEqual({ ok: true, prices: { text: 'price_starter_text' } });
  });

  it('free_ad と enterprise は自動オンボーディングの対象外', () => {
    expect(getSubscriptionItemPrices('free_ad')).toEqual({ ok: false, reason: 'plan_not_self_serve' });
    expect(getSubscriptionItemPrices('enterprise')).toEqual({ ok: false, reason: 'plan_not_self_serve' });
  });

  it('Starter に年払いは無い(基本料が無く請求周期が定義できない)', () => {
    expect(getSubscriptionItemPrices('starter', 'annual')).toEqual({
      ok: false, reason: 'billing_cycle_not_supported',
    });
  });

  it('Starter は STRIPE_PRICE_STARTER_TEXT 未設定なら旧 STRIPE_METERED_PRICE_ID へフォールバックする', () => {
    delete process.env.STRIPE_PRICE_STARTER_TEXT;
    process.env.STRIPE_METERED_PRICE_ID = 'price_legacy';
    expect(getSubscriptionItemPrices('starter')).toEqual({ ok: true, prices: { text: 'price_legacy' } });
  });

  it('Starter の price がどちらも未設定なら price_not_configured', () => {
    delete process.env.STRIPE_PRICE_STARTER_TEXT;
    expect(getSubscriptionItemPrices('starter')).toEqual({
      ok: false, reason: 'price_not_configured', missing: ['STRIPE_PRICE_STARTER_TEXT'],
    });
  });

  // ★一部だけ設定されている状態で作らない★
  // 3本のうちアバター超過だけ欠けた subscription を作ると、アバターの超過分が
  // 「請求されないまま誰も気づかない」状態になる(禁止50 と同型)。
  it('込み枠プランは3本揃わなければ作らず、欠けている env 名を返す', () => {
    delete process.env.STRIPE_PRICE_STANDARD_AVATAR_OVERAGE;
    expect(getSubscriptionItemPrices('standard', 'monthly')).toEqual({
      ok: false, reason: 'price_not_configured', missing: ['STRIPE_PRICE_STANDARD_AVATAR_OVERAGE'],
    });

    delete process.env.STRIPE_PRICE_STANDARD_TEXT_OVERAGE;
    expect(getSubscriptionItemPrices('standard', 'monthly')).toEqual({
      ok: false, reason: 'price_not_configured',
      missing: ['STRIPE_PRICE_STANDARD_TEXT_OVERAGE', 'STRIPE_PRICE_STANDARD_AVATAR_OVERAGE'],
    });
  });

  it('年払いは env の設定状況によらずブロックする(price_not_configured へフォールバックしない)', () => {
    delete process.env.STRIPE_PRICE_STANDARD_BASE_ANNUAL;
    expect(getSubscriptionItemPrices('standard', 'annual')).toEqual({
      ok: false, reason: 'billing_cycle_not_supported',
    });
  });

  it('billingCycle 省略時は月払い', () => {
    expect((getSubscriptionItemPrices('standard') as any).prices.base).toBe('price_std_base_m');
  });
});
