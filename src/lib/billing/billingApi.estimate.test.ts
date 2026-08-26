// src/lib/billing/billingApi.estimate.test.ts
// computeBillingEstimateJpy — 「今期の請求見積り」の計算式そのもののテスト。
//
// ★このテストが守っている事故(UX-B, 2026-08-26)★
// 旧実装は #1015(Standard/Growth を「基本料+込み枠+超過」に変更)より前のまま
// 残っており、単一の STRIPE_METERED_PRICE_ID(旧・全プラン共通price)を
// billedQuantity(= プラン倍率で重み付け済みの数量)に掛けていた。#1015 で倍率は
// price側(プランごとに分かれたStripe price)に移ったため、この掛け算は二重適用
// (Standard +25% / Growth +50%)であり、しかも基本料・込み枠・アバター分単価を
// 一切見ていなかった。この数字はテナントに直接見える(旧UI BillingSummaryCards.tsx・
// 新UI copilot-preview・チャットエージェントの get_billing_summary)ため、
// 誤りは即座にテナントへの誤情報になる。

import { computeBillingEstimateJpy, _resetPriceCacheForTest } from "./billingApi";
import { computeExpectedBilling } from "./stripeSync";

jest.mock("./stripeSync", () => ({
  computeExpectedBilling: jest.fn(),
}));

const mockComputeExpectedBilling = computeExpectedBilling as jest.Mock;

/** Stripe price オブジェクトの最小形。 */
function perUnitPrice(unitAmount: number) {
  return { billing_scheme: "per_unit", unit_amount: unitAmount };
}

function makeDb(plan: string | null | undefined) {
  return {
    query: jest.fn(async (sql: string) => {
      if (sql.includes("SELECT plan FROM tenants")) {
        return plan === undefined ? { rows: [] } : { rows: [{ plan }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
}

/** price ID → price オブジェクトの対応表から stripe.prices.retrieve をモックする。 */
function makeStripe(priceTable: Record<string, unknown>) {
  return {
    prices: {
      retrieve: jest.fn(async (priceId: string) => {
        if (!(priceId in priceTable)) throw new Error(`unknown price: ${priceId}`);
        return priceTable[priceId];
      }),
    },
  };
}

const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_STARTER_TEXT",
  "STRIPE_METERED_PRICE_ID",
  "STRIPE_PRICE_STANDARD_BASE_MONTHLY",
  "STRIPE_PRICE_STANDARD_TEXT_OVERAGE",
  "STRIPE_PRICE_STANDARD_AVATAR_OVERAGE",
  "STRIPE_PRICE_GROWTH_BASE_MONTHLY",
  "STRIPE_PRICE_GROWTH_TEXT_OVERAGE",
  "STRIPE_PRICE_GROWTH_AVATAR_OVERAGE",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.clearAllMocks();
  _resetPriceCacheForTest();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_PRICE_STARTER_TEXT = "price_starter_text";
  delete process.env.STRIPE_METERED_PRICE_ID;
  process.env.STRIPE_PRICE_STANDARD_BASE_MONTHLY = "price_std_base";
  process.env.STRIPE_PRICE_STANDARD_TEXT_OVERAGE = "price_std_text";
  process.env.STRIPE_PRICE_STANDARD_AVATAR_OVERAGE = "price_std_avatar";
  process.env.STRIPE_PRICE_GROWTH_BASE_MONTHLY = "price_growth_base";
  process.env.STRIPE_PRICE_GROWTH_TEXT_OVERAGE = "price_growth_text";
  process.env.STRIPE_PRICE_GROWTH_AVATAR_OVERAGE = "price_growth_avatar";

  mockComputeExpectedBilling.mockResolvedValue({
    totalRequests: 0, totalCostCents: 0, billableUnits: 0, unstampedRows: 0,
    billedQuantity: 999999, fallbackMultiplier: 1, // ★意図的に大きい値★
    // billedQuantity は倍率込みの旧経路。この値を新式が一切参照していないことを、
    // 「もし参照していたら明らかにおかしい金額になる」ダミー値で間接的に固定する。
    textUnits: 0,
    avatarMinutes: 0,
  });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
});

describe("computeBillingEstimateJpy", () => {
  it("STRIPE_SECRET_KEY が未設定なら null(算出不可)", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const db = makeDb("starter");
    const result = await computeBillingEstimateJpy(db, "tenant-a", "2026-08-01", "2026-09-01");
    expect(result).toBeNull();
  });

  it("テナントが存在しなければ null", async () => {
    const db = makeDb(undefined);
    const result = await computeBillingEstimateJpy(db, "tenant-a", "2026-08-01", "2026-09-01");
    expect(result).toBeNull();
  });

  // ★free_adは0円が正しい(算出不可ではない)★ 倍率0で実際に無料。
  // null(算出不可)と数値0(実際に無料)を混同すると、0を「今月は無料」と
  // 誤読させる禁止20と同じ問題が逆向きに起きる(本当に無料なのに算出不可と出す)。
  it("free_ad は Stripe を一切呼ばず 0 を返す(算出不可のnullではない)", async () => {
    const db = makeDb("free_ad");
    const stripe = makeStripe({});
    const result = await computeBillingEstimateJpy(db, "tenant-a", "2026-08-01", "2026-09-01");
    expect(result).toBe(0);
    void stripe; // free_adはStripeクライアント自体を作らない経路であることの記録
  });

  describe("starter(純従量・基本料も込み枠も無い)", () => {
    it("会話数 × 単価をそのまま返す(倍率を掛けない)", async () => {
      mockComputeExpectedBilling.mockResolvedValue({
        textUnits: 42, avatarMinutes: 0, billedQuantity: 999999,
        totalRequests: 0, totalCostCents: 0, billableUnits: 0, unstampedRows: 0, fallbackMultiplier: 1,
      });
      const db = makeDb("starter");
      jest.doMock("stripe", () => jest.fn());
      const result = await withStripeClient({ price_starter_text: perUnitPrice(20) }, () =>
        computeBillingEstimateJpy(db, "tenant-a", "2026-08-01", "2026-09-01")
      );
      expect(result).toBe(42 * 20);
    });

    it("plan が null(未確定)でも starter として計算する(planMultiplierと同じfail-safeの向き)", async () => {
      mockComputeExpectedBilling.mockResolvedValue({
        textUnits: 10, avatarMinutes: 0, billedQuantity: 999999,
        totalRequests: 0, totalCostCents: 0, billableUnits: 0, unstampedRows: 0, fallbackMultiplier: 1,
      });
      const db = makeDb(null);
      const result = await withStripeClient({ price_starter_text: perUnitPrice(20) }, () =>
        computeBillingEstimateJpy(db, "tenant-a", "2026-08-01", "2026-09-01")
      );
      expect(result).toBe(200);
    });

    // getSubscriptionItemPrices(planPricing.ts)は STRIPE_PRICE_STARTER_TEXT 未設定時に
    // 旧 STRIPE_METERED_PRICE_ID(¥10のプレースホルダ)へフォールバックする既存仕様がある。
    // ここではその仕様自体の当否ではなく、フォールバックした price を使った場合でも
    // computeBillingEstimateJpy 側の計算式(数量×単価、倍率を掛けない)が壊れないことを
    // 確認する(price envが両方とも欠けていれば price_not_configured で null になる方は
    // subscriptionSync.test.ts / billingApi.checkoutSession.test.ts で別途担保済み)。
    it("STRIPE_PRICE_STARTER_TEXT 未設定時は旧METERED_PRICE_IDへフォールバックした価格で計算する", async () => {
      delete process.env.STRIPE_PRICE_STARTER_TEXT;
      process.env.STRIPE_METERED_PRICE_ID = "price_legacy_10yen";
      mockComputeExpectedBilling.mockResolvedValue({
        textUnits: 10, avatarMinutes: 0, billedQuantity: 999999,
        totalRequests: 0, totalCostCents: 0, billableUnits: 0, unstampedRows: 0, fallbackMultiplier: 1,
      });
      const db = makeDb("starter");
      const result = await withStripeClient({ price_legacy_10yen: perUnitPrice(10) }, () =>
        computeBillingEstimateJpy(db, "tenant-a", "2026-08-01", "2026-09-01")
      );
      expect(result).toBe(100); // ¥10 × 10件(確定価格の¥20ではなく、実際に使われたフォールバック単価と一致すること)
    });
  });

  describe("standard(基本料 + 込み枠1,000会話/30分 + 超過¥25/¥100)", () => {
    it("込み枠ちょうどなら基本料のみ(超過0円)", async () => {
      mockComputeExpectedBilling.mockResolvedValue({
        textUnits: 1000, avatarMinutes: 30, billedQuantity: 999999,
        totalRequests: 0, totalCostCents: 0, billableUnits: 0, unstampedRows: 0, fallbackMultiplier: 1,
      });
      const db = makeDb("standard");
      const result = await withStripeClient(
        { price_std_base: perUnitPrice(9800), price_std_text: perUnitPrice(25), price_std_avatar: perUnitPrice(100) },
        () => computeBillingEstimateJpy(db, "tenant-a", "2026-08-01", "2026-09-01")
      );
      expect(result).toBe(9800);
    });

    it("込み枠未満でも超過はマイナスにならない(0円のまま)", async () => {
      mockComputeExpectedBilling.mockResolvedValue({
        textUnits: 100, avatarMinutes: 5, billedQuantity: 999999,
        totalRequests: 0, totalCostCents: 0, billableUnits: 0, unstampedRows: 0, fallbackMultiplier: 1,
      });
      const db = makeDb("standard");
      const result = await withStripeClient(
        { price_std_base: perUnitPrice(9800), price_std_text: perUnitPrice(25), price_std_avatar: perUnitPrice(100) },
        () => computeBillingEstimateJpy(db, "tenant-a", "2026-08-01", "2026-09-01")
      );
      expect(result).toBe(9800);
    });

    it("両次元とも超過: 基本料 + テキスト超過×¥25 + アバター超過×¥100", async () => {
      mockComputeExpectedBilling.mockResolvedValue({
        textUnits: 1200, avatarMinutes: 45, billedQuantity: 999999, // +200会話 / +15分
        totalRequests: 0, totalCostCents: 0, billableUnits: 0, unstampedRows: 0, fallbackMultiplier: 1,
      });
      const db = makeDb("standard");
      const result = await withStripeClient(
        { price_std_base: perUnitPrice(9800), price_std_text: perUnitPrice(25), price_std_avatar: perUnitPrice(100) },
        () => computeBillingEstimateJpy(db, "tenant-a", "2026-08-01", "2026-09-01")
      );
      // 9800 + 200*25 + 15*100 = 9800 + 5000 + 1500 = 16300
      expect(result).toBe(16300);
    });

    // ★テキストとアバターを合算しない(必須要件)★ 合算する実装だと、
    // アバターに偏ったテナントでテキストの余剰枠がアバター超過を相殺してしまう。
    it("片方だけ大幅超過してももう片方の枠を消費しない(別枠であることの確認)", async () => {
      mockComputeExpectedBilling.mockResolvedValue({
        textUnits: 0, avatarMinutes: 200, // テキストは0、アバターだけ170分超過
        billedQuantity: 999999,
        totalRequests: 0, totalCostCents: 0, billableUnits: 0, unstampedRows: 0, fallbackMultiplier: 1,
      });
      const db = makeDb("standard");
      const result = await withStripeClient(
        { price_std_base: perUnitPrice(9800), price_std_text: perUnitPrice(25), price_std_avatar: perUnitPrice(100) },
        () => computeBillingEstimateJpy(db, "tenant-a", "2026-08-01", "2026-09-01")
      );
      // 9800 + 0(テキスト超過なし) + 170*100 = 9800 + 17000 = 26800
      expect(result).toBe(26800);
    });

    it("price envが一部でも欠けていれば null(黙って一部だけで計算しない)", async () => {
      delete process.env.STRIPE_PRICE_STANDARD_AVATAR_OVERAGE;
      mockComputeExpectedBilling.mockResolvedValue({
        textUnits: 1200, avatarMinutes: 45, billedQuantity: 999999,
        totalRequests: 0, totalCostCents: 0, billableUnits: 0, unstampedRows: 0, fallbackMultiplier: 1,
      });
      const db = makeDb("standard");
      const result = await withStripeClient(
        { price_std_base: perUnitPrice(9800), price_std_text: perUnitPrice(25) },
        () => computeBillingEstimateJpy(db, "tenant-a", "2026-08-01", "2026-09-01")
      );
      expect(result).toBeNull();
    });

    // ★このテストがキャッシュのバグ(旧実装なら起こりうる)を検出する★
    // 単一キャッシュの実装だと、base→text→avatarOverage の順で取得するうちに
    // 最後の値で上書きされ、baseの単価が化ける。price IDごとに独立している
    // ことを、3本とも異なる金額にして相互汚染が無いことで確認する。
    it("基本料・テキスト超過・アバター超過の3価格が互いを上書きしない(price別キャッシュ)", async () => {
      mockComputeExpectedBilling.mockResolvedValue({
        textUnits: 1100, avatarMinutes: 40, billedQuantity: 999999, // +100 / +10
        totalRequests: 0, totalCostCents: 0, billableUnits: 0, unstampedRows: 0, fallbackMultiplier: 1,
      });
      const db = makeDb("standard");
      const result = await withStripeClient(
        { price_std_base: perUnitPrice(9800), price_std_text: perUnitPrice(25), price_std_avatar: perUnitPrice(100) },
        () => computeBillingEstimateJpy(db, "tenant-a", "2026-08-01", "2026-09-01")
      );
      // 9800 + 100*25 + 10*100 = 9800 + 2500 + 1000 = 13300
      // (もし3本が同じキャッシュキーで衝突していれば、最後に取得したavatarOverage
      //  の¥100がbaseとして誤用され、9800の代わりに100が使われるなど値が壊れる)
      expect(result).toBe(13300);
    });
  });

  describe("growth(基本料 + 込み枠3,000会話/150分 + 超過¥30/¥80)", () => {
    it("基本料 + 両次元の超過", async () => {
      mockComputeExpectedBilling.mockResolvedValue({
        textUnits: 3100, avatarMinutes: 160, // +100 / +10
        billedQuantity: 999999,
        totalRequests: 0, totalCostCents: 0, billableUnits: 0, unstampedRows: 0, fallbackMultiplier: 1,
      });
      const db = makeDb("growth");
      const result = await withStripeClient(
        { price_growth_base: perUnitPrice(29800), price_growth_text: perUnitPrice(30), price_growth_avatar: perUnitPrice(80) },
        () => computeBillingEstimateJpy(db, "tenant-a", "2026-08-01", "2026-09-01")
      );
      // 29800 + 100*30 + 10*80 = 29800 + 3000 + 800 = 33600
      expect(result).toBe(33600);
    });
  });

  // enterprise は個別契約。getSubscriptionItemPrices が plan_not_self_serve を
  // 返すため自然に null に落ちる — 「自動算出しない」という既存方針と一致する。
  it("enterprise は null(個別契約のため自動算出しない)", async () => {
    const db = makeDb("enterprise");
    const result = await withStripeClient({}, () =>
      computeBillingEstimateJpy(db, "tenant-a", "2026-08-01", "2026-09-01")
    );
    expect(result).toBeNull();
  });

  it("Stripeのprice取得が失敗すれば null(例外を外に漏らさない)", async () => {
    mockComputeExpectedBilling.mockResolvedValue({
      textUnits: 10, avatarMinutes: 0, billedQuantity: 999999,
      totalRequests: 0, totalCostCents: 0, billableUnits: 0, unstampedRows: 0, fallbackMultiplier: 1,
    });
    const db = makeDb("starter");
    const stripe = { prices: { retrieve: jest.fn().mockRejectedValue(new Error("stripe down")) } };
    const result = await computeBillingEstimateJpyWithStripe(stripe, db, "tenant-a", "2026-08-01", "2026-09-01");
    expect(result).toBeNull();
  });

  it("price が段階制(per_unit以外)なら null(単純計算が成立しないため推測しない)", async () => {
    mockComputeExpectedBilling.mockResolvedValue({
      textUnits: 10, avatarMinutes: 0, billedQuantity: 999999,
      totalRequests: 0, totalCostCents: 0, billableUnits: 0, unstampedRows: 0, fallbackMultiplier: 1,
    });
    const db = makeDb("starter");
    const result = await withStripeClient(
      { price_starter_text: { billing_scheme: "tiered" } },
      () => computeBillingEstimateJpy(db, "tenant-a", "2026-08-01", "2026-09-01")
    );
    expect(result).toBeNull();
  });

  it("15分キャッシュ内の再呼び出しは Stripe を再度叩かない", async () => {
    mockComputeExpectedBilling.mockResolvedValue({
      textUnits: 10, avatarMinutes: 0, billedQuantity: 999999,
      totalRequests: 0, totalCostCents: 0, billableUnits: 0, unstampedRows: 0, fallbackMultiplier: 1,
    });
    const db = makeDb("starter");
    const stripe = makeStripe({ price_starter_text: perUnitPrice(20) });
    const stripeModule = require("stripe");
    stripeModule.mockImplementation(() => stripe);

    await computeBillingEstimateJpy(db, "tenant-a", "2026-08-01", "2026-09-01");
    await computeBillingEstimateJpy(db, "tenant-b", "2026-08-01", "2026-09-01");

    expect(stripe.prices.retrieve).toHaveBeenCalledTimes(1);
  });
});

// ─── ヘルパー: 'stripe' パッケージをモックしてクライアントを差し込む ──────────

jest.mock("stripe", () => jest.fn(), { virtual: true });

async function withStripeClient<T>(priceTable: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const stripe = makeStripe(priceTable);
  const stripeModule = require("stripe");
  stripeModule.mockImplementation(() => stripe);
  return fn();
}

async function computeBillingEstimateJpyWithStripe(
  stripe: unknown,
  db: any,
  tenantId: string,
  from: string,
  to: string,
) {
  const stripeModule = require("stripe");
  stripeModule.mockImplementation(() => stripe);
  return computeBillingEstimateJpy(db, tenantId, from, to);
}
