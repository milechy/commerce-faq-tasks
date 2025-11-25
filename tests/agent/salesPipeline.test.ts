// tests/agent/salesPipeline.test.ts

import assert from "assert";
import type { PlannerPlan } from "../../src/agent/dialog/types";
import { runSalesPipeline } from "../../src/agent/orchestrator/sales/salesPipeline";

function makePlan(partial: Partial<PlannerPlan>): PlannerPlan {
  return {
    steps: [],
    needsClarification: false,
    confidence: "medium",
    clarifyingQuestions: [],
    followupQueries: [],
    ...partial,
  };
}

async function testUpsellFromPlan() {
  const plan: PlannerPlan = makePlan({
    steps: [
      {
        id: "step_recommend_1",
        stage: "recommend",
        title: "おすすめプランの提示",
        description:
          "ユーザーの用途や制約に合わせて、具体的なプランや商品構成を1〜3個ほど提案するステップ。上位プランが適切ならその提案も含める。",
        // productIds が空でも、上記 description によるプレミアム判定が効く想定
      } as any,
    ],
  });

  const meta = runSalesPipeline(
    {
      userMessage: "今のプランより、少し上位のおすすめプランはありますか？",
      history: [],
      plan,
    },
    undefined
  );

  assert.strictEqual(
    meta.upsellTriggered,
    true,
    "upsellTriggered should be true when recommend step has premium-like description"
  );
  assert.ok(
    meta.notes?.includes("planner:recommend-with-upsell-hint"),
    'notes should include "planner:recommend-with-upsell-hint"'
  );
}

async function testCtaFromPlan() {
  const plan: PlannerPlan = makePlan({
    steps: [
      {
        id: "step_close_1",
        stage: "close",
        title: "クロージングと行動提案",
        description:
          "不安を1つだけケアしたうえで、次に取るべき具体的な行動（購入／予約／問い合わせなど）を1つ提案するステップ。",
        cta: "purchase",
      } as any,
    ],
  });

  const meta = runSalesPipeline(
    {
      userMessage: "これで購入したいです。どうすればいいですか？",
      history: [],
      plan,
    },
    undefined
  );

  assert.strictEqual(
    meta.ctaTriggered,
    true,
    "ctaTriggered should be true when close step has cta set"
  );
  assert.ok(
    meta.notes?.some((n) => n.startsWith("planner:cta:")),
    'notes should include a "planner:cta:*" entry'
  );
}

async function testUpsellFromTextOnly() {
  const meta = runSalesPipeline(
    {
      userMessage: "もっと良い上位プランやおすすめがあれば教えてください。",
      history: [],
      plan: undefined,
    },
    undefined
  );

  assert.strictEqual(
    meta.upsellTriggered,
    true,
    "upsellTriggered should be true when userMessage contains upsell keywords"
  );
  assert.ok(
    meta.notes?.includes("heuristic:upsell-keyword-detected"),
    'notes should include "heuristic:upsell-keyword-detected"'
  );
}

async function testCtaFromTextOnly() {
  const meta = runSalesPipeline(
    {
      userMessage: "このプランを購入したいです。",
      history: [],
      plan: undefined,
    },
    undefined
  );

  assert.strictEqual(
    meta.ctaTriggered,
    true,
    "ctaTriggered should be true when userMessage contains CTA keywords"
  );
  assert.ok(
    meta.notes?.includes("heuristic:cta-keyword-detected"),
    'notes should include "heuristic:cta-keyword-detected"'
  );
}

async function testMergeWithPreviousMeta() {
  const previousMeta = {
    upsellTriggered: true,
    ctaTriggered: false,
    notes: ["manual:previous-session-upsell"],
  };

  const meta = runSalesPipeline(
    {
      userMessage: "今日は特にアップセル要素はない質問です。",
      history: [],
      plan: undefined,
    },
    previousMeta
  );

  // 新しい入力では upsell/cta を検出しなくても、以前の upsellTriggered は維持される想定
  assert.strictEqual(
    meta.upsellTriggered,
    true,
    "upsellTriggered should remain true when previousMeta.upsellTriggered is true"
  );
  assert.ok(
    meta.notes?.includes("manual:previous-session-upsell"),
    "previous notes should be preserved and merged"
  );
}

async function main() {
  console.log("Running salesPipeline tests...");

  await testUpsellFromPlan();
  await testCtaFromPlan();
  await testUpsellFromTextOnly();
  await testCtaFromTextOnly();
  await testMergeWithPreviousMeta();

  console.log("salesPipeline tests passed 🎉");
}

// ts-node で直接実行したとき用
main().catch((err) => {
  console.error("salesPipeline tests failed ❌");
  console.error(err);
  process.exit(1);
});
