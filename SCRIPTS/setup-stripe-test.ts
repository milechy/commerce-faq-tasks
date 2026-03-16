#!/usr/bin/env ts-node
/**
 * SCRIPTS/setup-stripe-test.ts
 * Stripe テストモードで carnation テナントの Customer + Subscription を作成し
 * stripe_subscriptions テーブルに保存する。
 *
 * 使い方:
 *   pnpm tsx SCRIPTS/setup-stripe-test.ts
 *   pnpm tsx SCRIPTS/setup-stripe-test.ts --tenant=demo
 */

import "dotenv/config";
// @ts-ignore
import Stripe from "stripe";
// @ts-ignore
import { Pool } from "pg";

const TENANT_ID = process.argv.find((a) => a.startsWith("--tenant="))?.split("=")[1] ?? "carnation";

async function main() {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) { console.error("STRIPE_SECRET_KEY is not set"); process.exit(1); }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error("DATABASE_URL is not set"); process.exit(1); }

  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) { console.error("STRIPE_PRICE_ID is not set"); process.exit(1); }

  const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" });
  const pool = new Pool({ connectionString: dbUrl });

  try {
    // 1. テナント名を取得
    const tenantRes = await pool.query("SELECT id, name FROM tenants WHERE id = $1 LIMIT 1", [TENANT_ID]);
    if (tenantRes.rows.length === 0) {
      console.error(`テナント '${TENANT_ID}' が tenants テーブルに存在しません`);
      process.exit(1);
    }
    const tenantName = tenantRes.rows[0].name as string;
    console.log(`テナント確認OK: ${TENANT_ID} / ${tenantName}`);

    // 2. 既存の stripe_subscriptions を確認
    const existingRes = await pool.query(
      "SELECT stripe_customer_id, stripe_subscription_id FROM stripe_subscriptions WHERE tenant_id = $1 LIMIT 1",
      [TENANT_ID]
    );

    let customerId: string;
    let subscriptionId: string;

    if (existingRes.rows.length > 0) {
      customerId = existingRes.rows[0].stripe_customer_id as string;
      subscriptionId = existingRes.rows[0].stripe_subscription_id as string;
      console.log(`既存レコード確認: customer=${customerId}, subscription=${subscriptionId}`);

      // Stripe上で実際に存在するか確認
      try {
        await stripe.customers.retrieve(customerId);
        console.log(`✅ Stripe Customer 確認OK: ${customerId}`);
      } catch {
        console.log(`Customer ${customerId} が Stripe に見つかりません。再作成します。`);
        customerId = "";
      }
    } else {
      customerId = "";
      subscriptionId = "";
    }

    // 3. Customer 作成（必要な場合）
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: tenantName,
        email: `${TENANT_ID}@example.com`,
        metadata: { tenant_id: TENANT_ID },
      });
      customerId = customer.id;
      console.log(`新規 Stripe Customer 作成: ${customerId}`);
    }

    // 4. Subscription 作成（必要な場合）
    if (!subscriptionId) {
      const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: priceId }],
        metadata: { tenant_id: TENANT_ID },
      });
      subscriptionId = subscription.id;
      console.log(`新規 Stripe Subscription 作成: ${subscriptionId}`);
    } else {
      // 既存 Subscription が Stripe 上に存在するか確認
      try {
        await stripe.subscriptions.retrieve(subscriptionId);
        console.log(`✅ Stripe Subscription 確認OK: ${subscriptionId}`);
      } catch {
        console.log(`Subscription ${subscriptionId} が Stripe に見つかりません。再作成します。`);
        const subscription = await stripe.subscriptions.create({
          customer: customerId,
          items: [{ price: priceId }],
          metadata: { tenant_id: TENANT_ID },
        });
        subscriptionId = subscription.id;
        console.log(`新規 Stripe Subscription 作成: ${subscriptionId}`);
      }
    }

    // 5. DB に upsert
    await pool.query(
      `INSERT INTO stripe_subscriptions
         (tenant_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, is_active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (tenant_id) DO UPDATE SET
         stripe_customer_id     = EXCLUDED.stripe_customer_id,
         stripe_subscription_id = EXCLUDED.stripe_subscription_id,
         stripe_price_id        = EXCLUDED.stripe_price_id,
         is_active              = true,
         updated_at             = NOW()`,
      [TENANT_ID, customerId, subscriptionId, priceId]
    );
    console.log(`✅ stripe_subscriptions に保存しました`);

    // 6. 確認
    const check = await pool.query(
      "SELECT tenant_id, stripe_customer_id, stripe_subscription_id, is_active FROM stripe_subscriptions WHERE tenant_id = $1",
      [TENANT_ID]
    );
    console.log("DB確認:", check.rows[0]);

  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
