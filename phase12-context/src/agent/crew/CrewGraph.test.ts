// src/agent/crew/CrewGraph.test.ts
import "dotenv/config";
import assert from "node:assert/strict";

import { CrewOrchestrator } from "./CrewOrchestrator";

async function test_crewgraph_linear_flow() {
  const crew = new CrewOrchestrator();

  // CrewOrchestrator.run 経由で CrewGraph のノードパイプラインを通す
  const result = await crew.run({
    message: "返品送料について教えてください",
    history: [],
    context: {
      locale: "ja",
      tenantId: "test-tenant",
      sessionId: "test-session",
      mode: "crew",
      useMultiStepPlanner: false,
    },
  });

  assert.ok(result, "crew.run should return a result");

  const meta = (result as any).meta;
  assert.ok(meta, "meta should be present");
  // sessionId は HTTP レイヤーで上書きされる場合もあるため、ここでは存在しても/しなくても許容する。
  if (typeof meta.sessionId !== "undefined") {
    assert.equal(typeof meta.sessionId, "string", "meta.sessionId should be string when present");
  }

  // plannerPlan があれば最低限 object であることだけ確認
  if (meta.plannerPlan) {
    assert.equal(typeof meta.plannerPlan, "object");
  }

  // text は string または null/undefined を許容
  const text = (result as any).text;
  assert.ok(
    typeof text === "string" || text === null || typeof text === "undefined",
    "text should be string, null or undefined",
  );
}

async function main() {
  console.log("Running CrewGraph pipeline tests...");
  let passed = 0;
  let failed = 0;

  try {
    await test_crewgraph_linear_flow();
    console.log("✅ crewgraph linear flow");
    passed++;
  } catch (err) {
    console.error("❌ crewgraph linear flow");
    console.error(err);
    failed++;
  }

  console.log("CrewGraph tests finished. passed=%d, failed=%d", passed, failed);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
