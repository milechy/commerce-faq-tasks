/**
 * planQuota ユニットテスト
 *
 * - getMonthRangeJst: JST月初ちょうど / 月末深夜 / 月またぎ / 年またぎ / TZ非依存
 * - isFreeAdMonthlyQuotaExceeded: 境界値(N-1/N/N+1) / 上限0 / 負の値で例外
 */

import { getMonthRangeJst, isFreeAdMonthlyQuotaExceeded, FREE_AD_MONTHLY_CONVERSATION_LIMIT, includedQuotaForPlan, computeQuotaOverage } from './planQuota';

describe('getMonthRangeJst', () => {
  it('JST月初(1日00:00:00.000)ちょうどでは monthStart が現在時刻と一致する', () => {
    const now = new Date('2026-07-31T15:00:00.000Z'); // 2026-08-01T00:00:00 JST
    const r = getMonthRangeJst(now);

    expect(r.monthStart.toISOString()).toBe('2026-07-31T15:00:00.000Z');
    expect(r.monthEnd.toISOString()).toBe('2026-08-31T15:00:00.000Z'); // 2026-09-01T00:00:00 JST
  });

  it('JST月末23:59:59.999でも同じ月の範囲のままである（月末の境界）', () => {
    const now = new Date('2026-08-31T14:59:59.999Z'); // 2026-08-31T23:59:59.999 JST
    const r = getMonthRangeJst(now);

    expect(r.monthStart.toISOString()).toBe('2026-07-31T15:00:00.000Z'); // 2026-08-01T00:00:00 JST
    expect(r.monthEnd.toISOString()).toBe('2026-08-31T15:00:00.000Z'); // 2026-09-01T00:00:00 JST
  });

  it('翌月に入った瞬間(JST 00:00:00.000ちょうど)に月が切り替わる', () => {
    const now = new Date('2026-08-31T15:00:00.000Z'); // 2026-09-01T00:00:00 JST
    const r = getMonthRangeJst(now);

    expect(r.monthStart.toISOString()).toBe('2026-08-31T15:00:00.000Z');
    expect(r.monthEnd.toISOString()).toBe('2026-09-30T15:00:00.000Z'); // 2026-10-01T00:00:00 JST
  });

  it('年またぎ(12月→1月)でも正しい月初を計算できる', () => {
    const now = new Date('2025-12-15T12:00:00.000Z'); // 2025-12-15T21:00:00 JST
    const r = getMonthRangeJst(now);

    expect(r.monthStart.toISOString()).toBe('2025-11-30T15:00:00.000Z'); // 2025-12-01T00:00:00 JST
    expect(r.monthEnd.toISOString()).toBe('2025-12-31T15:00:00.000Z'); // 2026-01-01T00:00:00 JST
  });

  it('2月(うるう年)でも正しく翌月(3月)へ切り替わる', () => {
    const now = new Date('2028-02-15T12:00:00.000Z'); // 2028年はうるう年
    const r = getMonthRangeJst(now);

    expect(r.monthStart.toISOString()).toBe('2028-01-31T15:00:00.000Z'); // 2028-02-01T00:00:00 JST
    expect(r.monthEnd.toISOString()).toBe('2028-02-29T15:00:00.000Z'); // 2028-03-01T00:00:00 JST(うるう年)
  });

  it('process.env.TZ を変更しても結果が変わらない（process TZ非依存の回帰検知）', () => {
    const now = new Date('2026-08-15T18:00:00.000Z');
    const originalTz = process.env.TZ;

    try {
      process.env.TZ = 'America/New_York';
      const inNy = getMonthRangeJst(now);

      process.env.TZ = 'UTC';
      const inUtc = getMonthRangeJst(now);

      expect(inNy.monthStart.toISOString()).toBe(inUtc.monthStart.toISOString());
      expect(inNy.monthEnd.toISOString()).toBe(inUtc.monthEnd.toISOString());
      expect(inUtc.monthStart.toISOString()).toBe('2026-07-31T15:00:00.000Z');
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('process.env.TZ = Asia/Tokyo でも UTC と同じ結果になる（境界時刻での回帰検知）', () => {
    const now = new Date('2026-08-31T14:59:59.999Z'); // JST月末ぎりぎり
    const originalTz = process.env.TZ;

    try {
      process.env.TZ = 'Asia/Tokyo';
      const inTokyo = getMonthRangeJst(now);

      process.env.TZ = 'UTC';
      const inUtc = getMonthRangeJst(now);

      expect(inTokyo.monthStart.toISOString()).toBe(inUtc.monthStart.toISOString());
      expect(inTokyo.monthEnd.toISOString()).toBe(inUtc.monthEnd.toISOString());
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});

describe('isFreeAdMonthlyQuotaExceeded', () => {
  it('既定の上限は200である', () => {
    expect(FREE_AD_MONTHLY_CONVERSATION_LIMIT).toBe(200);
  });

  it('上限未満(199件)なら false（200件目のリクエストを許可する）', () => {
    expect(isFreeAdMonthlyQuotaExceeded(199)).toBe(false);
  });

  it('ちょうど上限(200件)なら true（201件目のリクエストは拒否する）', () => {
    expect(isFreeAdMonthlyQuotaExceeded(200)).toBe(true);
  });

  it('上限超過(201件)なら true', () => {
    expect(isFreeAdMonthlyQuotaExceeded(201)).toBe(true);
  });

  it('0件なら false', () => {
    expect(isFreeAdMonthlyQuotaExceeded(0)).toBe(false);
  });

  it('上限を明示的に0にすると、0件でも true（初回のリクエストから拒否。無限ループ・無応答にならない）', () => {
    expect(isFreeAdMonthlyQuotaExceeded(0, 0)).toBe(true);
  });

  it('負のcountは例外を投げる', () => {
    expect(() => isFreeAdMonthlyQuotaExceeded(-1)).toThrow(/Invalid currentMonthConversationCount/);
  });

  it('負のlimitは例外を投げる', () => {
    expect(() => isFreeAdMonthlyQuotaExceeded(5, -1)).toThrow(/Invalid limit/);
  });

  it('カスタム上限を指定できる', () => {
    expect(isFreeAdMonthlyQuotaExceeded(9, 10)).toBe(false);
    expect(isFreeAdMonthlyQuotaExceeded(10, 10)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 込み枠(基本料に含まれる利用量)と超過数量。
// 確定価格 .claude/rules/billing.md §7:
//   Standard ¥9,800/月 = テキスト1,000会話 + アバター30分 込み、超過 ¥25/会話・¥100/分
//   Growth   ¥29,800/月 = テキスト3,000会話 + アバター150分 込み、超過 ¥30/会話・¥80/分
// ─────────────────────────────────────────────────────────────────────────────
describe('PLAN_INCLUDED_QUOTAS / includedQuotaForPlan', () => {
  it('Standard は テキスト1,000会話 + アバター30分', () => {
    expect(includedQuotaForPlan('standard')).toEqual({ textConversations: 1000, avatarMinutes: 30 });
  });

  it('Growth は テキスト3,000会話 + アバター150分', () => {
    expect(includedQuotaForPlan('growth')).toEqual({ textConversations: 3000, avatarMinutes: 150 });
  });

  // ★込み枠を持たないプランに枠を与えない★
  // starter は基本料0円の純従量(1単位目から課金)なので、ここで枠を返すと
  // 無料枠を新設することになり、そのまま請求漏れになる。free_ad は倍率0で
  // そもそも請求が発生せず、enterprise は個別交渉のため自動化しない。
  it('starter / free_ad / enterprise / 未知 / null は込み枠を持たない(null)', () => {
    expect(includedQuotaForPlan('starter')).toBeNull();
    expect(includedQuotaForPlan('free_ad')).toBeNull();
    expect(includedQuotaForPlan('enterprise')).toBeNull();
    expect(includedQuotaForPlan('unknown-plan')).toBeNull();
    expect(includedQuotaForPlan(null)).toBeNull();
    expect(includedQuotaForPlan(undefined)).toBeNull();
  });

  it('Object.prototype 由来のキーで枠が生えない', () => {
    expect(includedQuotaForPlan('constructor')).toBeNull();
    expect(includedQuotaForPlan('toString')).toBeNull();
  });
});

describe('computeQuotaOverage（込み枠の差し引き）', () => {
  it('込み枠内なら両次元とも超過0（基本料だけが請求される）', () => {
    expect(computeQuotaOverage('standard', 999, 29)).toEqual({ textConversations: 0, avatarMinutes: 0 });
    expect(computeQuotaOverage('standard', 1000, 30)).toEqual({ textConversations: 0, avatarMinutes: 0 });
  });

  it('テキストだけ超過したらテキストだけが超過数量になる', () => {
    expect(computeQuotaOverage('standard', 1200, 10)).toEqual({ textConversations: 200, avatarMinutes: 0 });
  });

  it('アバターだけ超過したらアバターだけが超過数量になる', () => {
    expect(computeQuotaOverage('standard', 500, 45)).toEqual({ textConversations: 0, avatarMinutes: 15 });
  });

  it('Growth は枠が大きいぶん、同じ利用量でも超過が小さい', () => {
    expect(computeQuotaOverage('growth', 1200, 45)).toEqual({ textConversations: 0, avatarMinutes: 0 });
    expect(computeQuotaOverage('growth', 3500, 200)).toEqual({ textConversations: 500, avatarMinutes: 50 });
  });

  // ★★★ 本PRで最も壊れやすい点 ★★★
  // 超過単価はプランごとに別の Stripe price として実在する
  // (テキスト Standard ¥25 / Growth ¥30、アバター Standard ¥100/分 / Growth ¥80/分)。
  // PLAN_MULTIPLIERS はその単価に既に織り込まれているため、数量側にも掛けると
  // 二重適用になる。「倍率を掛け忘れている」ように見えて親切に
  // `* planMultiplier(plan)` を足す変更が入ると、ここが赤になる。
  it('超過数量にプラン倍率(PLAN_MULTIPLIERS)を掛けない — 掛けると二重適用で過剰請求になる', () => {
    // Standard: 1,200会話 → 超過200会話。×1.25 した 250 になってはいけない。
    // (¥25 の price × 250 = ¥6,250 で、正しい ¥25 × 200 = ¥5,000 より 25% 多い)
    expect(computeQuotaOverage('standard', 1200, 0)!.textConversations).toBe(200);
    expect(computeQuotaOverage('standard', 1200, 0)!.textConversations).not.toBe(250);

    // Growth: 3,500会話 → 超過500会話。×1.5 した 750 になってはいけない。
    expect(computeQuotaOverage('growth', 3500, 0)!.textConversations).toBe(500);
    expect(computeQuotaOverage('growth', 3500, 0)!.textConversations).not.toBe(750);

    // アバターはさらに危険で、分単価が倍率と**逆向き**(Standard ¥100 → Growth ¥80)。
    // 倍率を掛けると「上位プランほど高くなる」向きに反転する(CLAUDE.md 禁止56)。
    expect(computeQuotaOverage('standard', 0, 50)!.avatarMinutes).toBe(20);
    expect(computeQuotaOverage('standard', 0, 50)!.avatarMinutes).not.toBe(25); // ×1.25
    expect(computeQuotaOverage('growth', 0, 250)!.avatarMinutes).toBe(100);
    expect(computeQuotaOverage('growth', 0, 250)!.avatarMinutes).not.toBe(150); // ×1.5
  });

  // 同じ利用量に対して、上位プランほどアバターの超過"金額"が安くなること
  // (数量ではなく単価で効く設計であることの確認)。
  it('込み枠を持たないプランは null を返し、呼び出し側は純従量経路へ倒れる', () => {
    expect(computeQuotaOverage('starter', 5000, 100)).toBeNull();
    expect(computeQuotaOverage('free_ad', 5000, 100)).toBeNull();
    expect(computeQuotaOverage('enterprise', 5000, 100)).toBeNull();
    expect(computeQuotaOverage(null, 5000, 100)).toBeNull();
  });

  it('超過は負にならない(0で下げ止まる)', () => {
    expect(computeQuotaOverage('standard', 0, 0)).toEqual({ textConversations: 0, avatarMinutes: 0 });
  });
});
