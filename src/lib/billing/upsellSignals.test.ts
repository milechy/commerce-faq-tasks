/**
 * upsellSignals.test.ts
 *
 * ★このテストが守っている一番大事なこと★
 * 出力に金額が1つも混ざらないこと。ここの結果は Hermes(外部VPSのLLM)へ渡り、
 * その生成文はテナントにも届く。金額が混ざると原価とマージン倍率が漏れる。
 */
import { computeUpsellSignals, isValidUpsellSignal } from './upsellSignals';
import { PLAN_INCLUDED_QUOTAS, FREE_AD_MONTHLY_CONVERSATION_LIMIT } from './planQuota';
import {
  STARTER_MONTHLY_BILLED_QUANTITY_CAP,
  GROWTH_TEXT_UNITS_ENTERPRISE_NUDGE_THRESHOLD,
} from './planPricing';

describe('computeUpsellSignals', () => {
  const STD = PLAN_INCLUDED_QUOTAS.standard!;

  it('★出力に金額を表すキーが1つも無い★', () => {
    const r = computeUpsellSignals({ plan: 'standard', textUnits: 2000, avatarMinutes: 60, adminConsults: 0 });
    expect(JSON.stringify(r)).not.toMatch(/jpy|cents|margin|cost|profit|price|amount|円|原価|粗利/i);
  });

  it('込み枠を超過すると text_overage / avatar_overage が立つ', () => {
    const r = computeUpsellSignals({
      plan: 'standard',
      textUnits: STD.textConversations + 100,
      avatarMinutes: STD.avatarMinutes + 5, adminConsults: 0,
    });
    expect(r.signals).toContain('text_overage');
    expect(r.signals).toContain('avatar_overage');
    expect(r.overage.textConversations).toBe(100);
    expect(r.overage.avatarMinutes).toBe(5);
  });

  it('超過していなくても8割で text_near_limit（超過してから気づかせない）', () => {
    const r = computeUpsellSignals({
      plan: 'standard', textUnits: Math.ceil(STD.textConversations * 0.8), avatarMinutes: 0, adminConsults: 0,
    });
    expect(r.signals).toContain('text_near_limit');
    expect(r.signals).not.toContain('text_overage');
  });

  it('7割では text_near_limit を出さない（過剰にプランを上げさせない）', () => {
    const r = computeUpsellSignals({
      plan: 'standard', textUnits: Math.floor(STD.textConversations * 0.7), avatarMinutes: 0, adminConsults: 0,
    });
    expect(r.signals).not.toContain('text_near_limit');
  });

  it('超過済みなら near_limit は重ねない（同じことを2回言わない）', () => {
    const r = computeUpsellSignals({
      plan: 'standard', textUnits: STD.textConversations + 1, avatarMinutes: 0, adminConsults: 0,
    });
    expect(r.signals).toContain('text_overage');
    expect(r.signals).not.toContain('text_near_limit');
  });

  it('★込み枠が無いプランの消化率は null（0% にしない）★', () => {
    const r = computeUpsellSignals({ plan: 'starter', textUnits: 100, avatarMinutes: 0, adminConsults: 0 });
    expect(r.utilizationPct.text).toBeNull();
    expect(r.utilizationPct.avatar).toBeNull();
  });

  it('Starter の上限到達で starter_cap_reached', () => {
    const r = computeUpsellSignals({
      plan: 'starter', textUnits: STARTER_MONTHLY_BILLED_QUANTITY_CAP, avatarMinutes: 0, adminConsults: 0,
    });
    expect(r.signals).toContain('starter_cap_reached');
    expect(r.nextPlanCandidate).toBe('standard');
  });

  it('free_ad の上限到達で free_ad_limit_reached', () => {
    const r = computeUpsellSignals({
      plan: 'free_ad', textUnits: FREE_AD_MONTHLY_CONVERSATION_LIMIT, avatarMinutes: 0, adminConsults: 0,
    });
    expect(r.signals).toContain('free_ad_limit_reached');
    expect(r.nextPlanCandidate).toBe('starter');
  });

  it('Growth の大規模利用で enterprise_nudge', () => {
    const r = computeUpsellSignals({
      plan: 'growth', textUnits: GROWTH_TEXT_UNITS_ENTERPRISE_NUDGE_THRESHOLD, avatarMinutes: 0, adminConsults: 0,
    });
    expect(r.signals).toContain('enterprise_nudge');
    expect(r.nextPlanCandidate).toBe('enterprise');
  });

  it('上位プランでの消化率を返す（上げれば収まるかを金額抜きで判断できる）', () => {
    const r = computeUpsellSignals({
      plan: 'standard', textUnits: 1500, avatarMinutes: 0, adminConsults: 0,
    });
    expect(r.utilizationPct.text).toBe(150);              // Standard では 150%
    expect(r.utilizationPctOnNextPlan.text).toBe(50);     // Growth(3000) なら 50%
  });

  it('enterprise は次が無く、込み枠も無いので上位消化率は null', () => {
    const r = computeUpsellSignals({ plan: 'enterprise', textUnits: 10_000, avatarMinutes: 0, adminConsults: 0 });
    expect(r.nextPlanCandidate).toBeNull();
    expect(r.utilizationPctOnNextPlan.text).toBeNull();
  });

  it('未知プラン / null でも落ちない', () => {
    expect(() => computeUpsellSignals({ plan: null, textUnits: 10, avatarMinutes: 0, adminConsults: 0 })).not.toThrow();
    expect(() => computeUpsellSignals({ plan: 'zzz', textUnits: 10, avatarMinutes: 0, adminConsults: 0 })).not.toThrow();
    expect(computeUpsellSignals({ plan: null, textUnits: 10, avatarMinutes: 0, adminConsults: 0 }).nextPlanCandidate).toBeNull();
  });

  it('利用が無ければシグナルは空（何も言わない）', () => {
    expect(computeUpsellSignals({ plan: 'standard', textUnits: 0, avatarMinutes: 0, adminConsults: 0 }).signals).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────
  // 管理AI原価の課金・可視化(S3)導入時の回帰防止: computeQuotaOverage が
  // adminConsults を必須引数化した後も、upsell の判定ロジックは
  // テキスト会話量だけを根拠にする(管理AI相談の超過を混ぜない)。
  // ─────────────────────────────────────────────────────────────────────
  it('管理AIの相談が大幅に込み枠を超えていても、テキスト側が枠内なら signals は空のまま', () => {
    const r = computeUpsellSignals({
      plan: 'standard', textUnits: 0, avatarMinutes: 0, adminConsults: 100_000,
    });
    expect(r.signals).toEqual([]);
    expect(r.overage).toEqual({ textConversations: 0, avatarMinutes: 0 });
  });

  it('管理AIの相談件数はoverage/utilizationPctのどちらにも現れない(出力は無次元のtext/avatarのみ)', () => {
    const withAdmin = computeUpsellSignals({
      plan: 'standard', textUnits: 500, avatarMinutes: 10, adminConsults: 900,
    });
    const withoutAdmin = computeUpsellSignals({
      plan: 'standard', textUnits: 500, avatarMinutes: 10, adminConsults: 0,
    });
    expect(withAdmin).toEqual(withoutAdmin);
  });
});

describe('isValidUpsellSignal', () => {
  it('既知のシグナルだけ通す（Hermes からの任意文字列を弾く）', () => {
    expect(isValidUpsellSignal('text_overage')).toBe(true);
    expect(isValidUpsellSignal('enterprise_nudge')).toBe(true);
    expect(isValidUpsellSignal('drop_tables')).toBe(false);
    expect(isValidUpsellSignal('')).toBe(false);
    expect(isValidUpsellSignal(null)).toBe(false);
    expect(isValidUpsellSignal(123)).toBe(false);
  });
});
