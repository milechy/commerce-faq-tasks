// src/lib/billing/subscriptionSync.test.ts
// プラン変更が Stripe の subscription item へ追随することのテスト。
//
// ★このテストが守っている事故★
// 1. 有料プランに上げたのに基本料 item が作られない = 月額が永久に請求されない
//    (#1015 以前の実挙動。プラン変更経路が Stripe を一切触っていなかった)
// 2. 上位プランへ移ったのに旧プランの基本料 item が残る = 二重請求
// 3. 当期に数量を報告済みの metered item を消す = その分の売上が黙って消える
// 4. free_ad へ降りたのにサブスクが生き続ける = 使っていない基本料を請求し続ける

import { syncSubscriptionItemsToPlan, needsBillingAttention } from "./subscriptionSync";

const silentLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

/** price を展開済みで返す subscription item。Stripe の retrieve は price を展開して返す。 */
function meteredItem(id: string, priceId: string) {
  return { id, price: { id: priceId, recurring: { usage_type: "metered" } } };
}
function licensedItem(id: string, priceId: string) {
  return { id, price: { id: priceId, recurring: { usage_type: "licensed" } } };
}

function makeDb(subscriptionId: string | null) {
  return {
    query: jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("FROM stripe_subscriptions")) {
        return subscriptionId
          ? { rows: [{ stripe_subscription_id: subscriptionId }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
}

function makeStripe(items: any[], opts: { cancelAtPeriodEnd?: boolean } = {}) {
  return {
    subscriptions: {
      retrieve: jest.fn(async (..._args: unknown[]) => ({
        items: { data: items },
        cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
      })),
      update: jest.fn(async (..._args: unknown[]) => ({})),
    },
  };
}

const ENV_KEYS = [
  "STRIPE_PRICE_STARTER_TEXT",
  "STRIPE_PRICE_STANDARD_BASE_MONTHLY",
  "STRIPE_PRICE_STANDARD_TEXT_OVERAGE",
  "STRIPE_PRICE_STANDARD_AVATAR_OVERAGE",
  "STRIPE_PRICE_GROWTH_BASE_MONTHLY",
  "STRIPE_PRICE_GROWTH_TEXT_OVERAGE",
  "STRIPE_PRICE_GROWTH_AVATAR_OVERAGE",
  "STRIPE_METERED_PRICE_ID",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.STRIPE_PRICE_STARTER_TEXT = "price_starter_text";
  process.env.STRIPE_PRICE_STANDARD_BASE_MONTHLY = "price_std_base";
  process.env.STRIPE_PRICE_STANDARD_TEXT_OVERAGE = "price_std_text";
  process.env.STRIPE_PRICE_STANDARD_AVATAR_OVERAGE = "price_std_avatar";
  process.env.STRIPE_PRICE_GROWTH_BASE_MONTHLY = "price_growth_base";
  process.env.STRIPE_PRICE_GROWTH_TEXT_OVERAGE = "price_growth_text";
  process.env.STRIPE_PRICE_GROWTH_AVATAR_OVERAGE = "price_growth_avatar";
  delete process.env.STRIPE_METERED_PRICE_ID;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
});

describe("syncSubscriptionItemsToPlan", () => {
  it("starter → standard で基本料・テキスト超過・アバター超過の3本を追加する", async () => {
    const db = makeDb("sub_1");
    const stripe = makeStripe([meteredItem("si_text", "price_starter_text")]);

    const result = await syncSubscriptionItemsToPlan(db, stripe, silentLogger, "tenant-a", "standard");

    expect(result.status).toBe("synced");
    expect(result.addedPrices).toEqual(
      expect.arrayContaining(["price_std_base", "price_std_text", "price_std_avatar"]),
    );
    const updateArg = stripe.subscriptions.update.mock.calls[0][1] as any;
    expect(updateArg.items).toEqual(
      expect.arrayContaining([{ price: "price_std_base" }, { price: "price_std_text" }]),
    );
  });

  // 旧プランの基本料が残ると Standard と Growth の両方が毎月請求される。
  it("standard → growth で旧プランの基本料(licensed)item を削除する", async () => {
    const db = makeDb("sub_1");
    const stripe = makeStripe([
      licensedItem("si_base_std", "price_std_base"),
      meteredItem("si_text_std", "price_std_text"),
      meteredItem("si_avatar_std", "price_std_avatar"),
    ]);

    const result = await syncSubscriptionItemsToPlan(db, stripe, silentLogger, "tenant-a", "growth");

    expect(result.status).toBe("synced");
    expect(result.removedItemIds).toEqual(["si_base_std"]);
    const updateArg = stripe.subscriptions.update.mock.calls[0][1] as any;
    expect(updateArg.items).toEqual(
      expect.arrayContaining([{ id: "si_base_std", deleted: true }]),
    );
  });

  // ★当期の売上を守る★ metered item には報告済みの数量がぶら下がっている。
  it("目標構成に無い metered item は削除しない(当期の報告済み数量を失わないため)", async () => {
    const db = makeDb("sub_1");
    const stripe = makeStripe([
      licensedItem("si_base_std", "price_std_base"),
      meteredItem("si_text_std", "price_std_text"),
    ]);

    const result = await syncSubscriptionItemsToPlan(db, stripe, silentLogger, "tenant-a", "growth");

    expect(result.removedItemIds).not.toContain("si_text_std");
    const updateArg = stripe.subscriptions.update.mock.calls[0][1] as any;
    expect(updateArg.items).not.toContainEqual({ id: "si_text_std", deleted: true });
  });

  // price が展開されず usage_type を読めない item は、判断材料が無いので触らない。
  it("usage_type を判定できない item は削除しない", async () => {
    const db = makeDb("sub_1");
    const stripe = makeStripe([{ id: "si_unknown", price: "price_legacy" }]);

    const result = await syncSubscriptionItemsToPlan(db, stripe, silentLogger, "tenant-a", "standard");

    expect(result.removedItemIds).toEqual([]);
    expect(silentLogger.warn).toHaveBeenCalled();
  });

  it("既に目標構成と一致していれば Stripe を更新しない", async () => {
    const db = makeDb("sub_1");
    const stripe = makeStripe([
      licensedItem("si_base", "price_std_base"),
      meteredItem("si_text", "price_std_text"),
      meteredItem("si_avatar", "price_std_avatar"),
    ]);

    const result = await syncSubscriptionItemsToPlan(db, stripe, silentLogger, "tenant-a", "standard");

    expect(result.status).toBe("no_change");
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  // free_ad へ落として戻ってきたテナントは cancel_at_period_end が立ったまま。
  // item を正しく組んでも期末に解約されるので、必ず降ろす。
  it("解約予約が残っている場合は有料プランへの復帰時に解除する", async () => {
    const db = makeDb("sub_1");
    const stripe = makeStripe(
      [
        licensedItem("si_base", "price_std_base"),
        meteredItem("si_text", "price_std_text"),
        meteredItem("si_avatar", "price_std_avatar"),
      ],
      { cancelAtPeriodEnd: true },
    );

    const result = await syncSubscriptionItemsToPlan(db, stripe, silentLogger, "tenant-a", "standard");

    expect(result.status).toBe("synced");
    expect((stripe.subscriptions.update.mock.calls[0][1] as any).cancel_at_period_end).toBe(false);
  });

  it("free_ad へ降格したら期末解約を予約する(即時解約はしない)", async () => {
    const db = makeDb("sub_1");
    const stripe = makeStripe([licensedItem("si_base", "price_std_base")]);

    const result = await syncSubscriptionItemsToPlan(db, stripe, silentLogger, "tenant-a", "free_ad");

    expect(result.status).toBe("scheduled_cancel");
    // 即時解約API(subscriptions.cancel)ではなく update での期末解約予約であることを、
    // 呼ばれた引数そのもので固定する。
    expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: true });
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
  });

  // enterprise は個別交渉。自動処理が契約内容を踏み潰さないことを固定する。
  it("enterprise は item を自動変更せず、人手が要る状態として返す", async () => {
    const db = makeDb("sub_1");
    const stripe = makeStripe([licensedItem("si_base", "price_growth_base")]);

    const result = await syncSubscriptionItemsToPlan(db, stripe, silentLogger, "tenant-a", "enterprise");

    expect(result.status).toBe("manual_plan");
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(needsBillingAttention(result)).toBe(true);
  });

  it("有料プランなのにアクティブな subscription が無ければ no_subscription を返す", async () => {
    const db = makeDb(null);
    const stripe = makeStripe([]);

    const result = await syncSubscriptionItemsToPlan(db, stripe, silentLogger, "tenant-a", "growth");

    expect(result.status).toBe("no_subscription");
    expect(needsBillingAttention(result)).toBe(true);
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("price の env が欠けていれば price_not_configured を返し、Stripe を触らない", async () => {
    delete process.env.STRIPE_PRICE_GROWTH_AVATAR_OVERAGE;
    const db = makeDb("sub_1");
    const stripe = makeStripe([]);

    const result = await syncSubscriptionItemsToPlan(db, stripe, silentLogger, "tenant-a", "growth");

    expect(result.status).toBe("price_not_configured");
    expect(result.missing).toContain("STRIPE_PRICE_GROWTH_AVATAR_OVERAGE");
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  // ★プランは既に COMMIT 済み★ ここで throw すると呼び出し元が 500 を返し、
  // 「変更に失敗した」と表示されてテナントが再送する。失敗は戻り値で表現する。
  it("Stripe が失敗しても例外を投げず failed を返す", async () => {
    const db = makeDb("sub_1");
    const stripe = makeStripe([]);
    stripe.subscriptions.retrieve = jest.fn(async () => {
      throw new Error("stripe is down");
    });

    const result = await syncSubscriptionItemsToPlan(db, stripe, silentLogger, "tenant-a", "standard");

    expect(result.status).toBe("failed");
    expect(needsBillingAttention(result)).toBe(true);
  });

  it("代表 price を stripe_subscriptions に書き戻す", async () => {
    const db = makeDb("sub_1");
    const stripe = makeStripe([]);

    await syncSubscriptionItemsToPlan(db, stripe, silentLogger, "tenant-a", "standard");

    const updateCall = db.query.mock.calls.find(
      (call: any) => typeof call[0] === "string" && call[0].includes("UPDATE stripe_subscriptions"),
    ) as any;
    expect(updateCall).toBeDefined();
    expect(updateCall[1][0]).toBe("price_std_base");
  });
});

describe("needsBillingAttention", () => {
  it.each([
    ["synced", false],
    ["no_change", false],
    ["not_billable_plan", false],
    ["scheduled_cancel", false],
    ["no_subscription", true],
    ["price_not_configured", true],
    ["stripe_not_configured", true],
    ["manual_plan", true],
    ["failed", true],
  ])("%s → %s", (status, expected) => {
    expect(needsBillingAttention({ status } as any)).toBe(expected);
  });
});
