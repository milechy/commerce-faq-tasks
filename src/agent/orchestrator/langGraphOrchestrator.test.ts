// src/agent/orchestrator/langGraphOrchestrator.test.ts
import "dotenv/config";
import assert from "node:assert/strict";

import { runDialogGraph } from "./langGraphOrchestrator";

// runDialogGraph の正確なシグネチャに依存しないよう any 経由で呼ぶヘルパ
const runForTest = runDialogGraph as unknown as (input: any) => Promise<any>;

async function test_langgraph_basic_flow() {
  // NOTE:
  // - 型定義に強く依存しないために any キャストを多用
  // - 目的は「例外を出さず、最低限の shape を満たすこと」のスモークテスト

  const input: any = {
    // DialogInput が期待するトップレベルのフィールド
    userMessage: "返品送料について教えてください",
    tenantId: "test-tenant",
    locale: "ja",
    conversationId: "test-session",
    // 旧インターフェース互換のためのフィールドも残しておく
    turn: {
      message: "返品送料について教えてください",
      sessionId: "test-session",
      options: {
        useMultiStepPlanner: false,
      },
    },
    history: [],
    meta: {
      route: "20b",
      plannerReasons: [],
      orchestratorMode: "langgraph",
      safetyTag: "none",
      requiresSafeMode: false,
      ragStats: {},
      graphVersion: "langgraph-v1",
      multiStepPlan: {},
      sessionId: "test-session",
    },
  };

  const out = await runForTest(input);

  assert.ok(out, "runDialogGraph should return a value");
  assert.equal(typeof out, "object", "output should be an object");

  const anyOut: any = out;

  // answer は string or null or undefined を許容（clarify の可能性もある）
  if (typeof anyOut.answer !== "undefined") {
    assert.ok(
      typeof anyOut.answer === "string" || anyOut.answer === null,
      "answer should be string or null when present"
    );
  }

  // steps があれば配列であること
  if (typeof anyOut.steps !== "undefined") {
    assert.ok(
      Array.isArray(anyOut.steps),
      "steps should be an array when present"
    );
  }

  // meta があれば object
  if (typeof anyOut.meta !== "undefined") {
    assert.equal(
      typeof anyOut.meta,
      "object",
      "meta should be an object when present"
    );
  }

  // graphVersion は存在すれば string
  if (typeof anyOut.graphVersion !== "undefined") {
    assert.equal(
      typeof anyOut.graphVersion,
      "string",
      "graphVersion should be string when present"
    );
  }
}

async function test_langgraph_rule_based_shipping_clarify() {
  const input: any = {
    userMessage: "配送について教えてください",
    tenantId: "test-tenant",
    locale: "ja",
    conversationId: "test-session",
    history: [],
  };

  const out = await runForTest(input);

  assert.ok(out, "runDialogGraph should return a value for shipping intent");
  const text = (out as any).text ?? (out as any).answer ?? "";

  assert.equal(typeof text, "string", "text should be a string");
  assert.ok(
    text.includes("どの商品（またはカテゴリ）") ||
      text.includes("お届け先の都道府県（または国）を教えてください。"),
    "shipping clarify text should contain at least one rule-based clarifying question",
  );
}

async function test_langgraph_rule_based_returns_clarify() {
  const input: any = {
    userMessage: "返品したいのですがどうすればいいですか？",
    tenantId: "test-tenant",
    locale: "ja",
    conversationId: "test-session",
    history: [],
  };

  const out = await runForTest(input);

  assert.ok(out, "runDialogGraph should return a value for returns intent");
  const text = (out as any).text ?? (out as any).answer ?? "";

  assert.equal(typeof text, "string", "text should be a string");
  assert.ok(
    text.includes("ご注文番号を教えていただけますか？") ||
      text.includes(
        "返品したい商品の名前または型番（SKU）を教えてください。",
      ) ||
      text.includes(
        "返品を希望される理由（サイズ違い・イメージ違い・不良品など）を教えてください。",
      ),
    "returns clarify text should contain at least one rule-based clarifying question",
  );
}

async function main() {
  console.log("Running LangGraph runtime tests...");
  let passed = 0;
  let failed = 0;

  try {
    await test_langgraph_basic_flow();
    console.log("✅ langgraph basic flow");
    passed++;
  } catch (err) {
    console.error("❌ langgraph basic flow");
    console.error(err);
    failed++;
  }

  try {
    await test_langgraph_rule_based_shipping_clarify();
    console.log("✅ langgraph rule-based shipping clarify");
    passed++;
  } catch (err) {
    console.error("❌ langgraph rule-based shipping clarify");
    console.error(err);
    failed++;
  }

  try {
    await test_langgraph_rule_based_returns_clarify();
    console.log("✅ langgraph rule-based returns clarify");
    passed++;
  } catch (err) {
    console.error("❌ langgraph rule-based returns clarify");
    console.error(err);
    failed++;
  }

  console.log(
    "LangGraph runtime tests finished. passed=%d, failed=%d",
    passed,
    failed,
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
