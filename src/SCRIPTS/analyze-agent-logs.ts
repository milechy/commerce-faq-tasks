// SCRIPTS/analyze-agent-logs.ts
// Simple CLI to compute basic latency stats (p50, p95) from pino JSON logs.
//
// Usage:
//   node dist/SCRIPTS/analyze-agent-logs.js /path/to/log.jsonl
//
// The script expects one JSON object per line (pino style). It looks for:
// - dialog.rag.finished: uses `totalMs` as RAG latency
// - planner logs (tag === "planner"): uses `latencyMs` as planner latency

import * as fs from "fs";
import * as readline from "readline";

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function summarize(name: string, values: number[]) {
  if (values.length === 0) {
    console.log(`\n[${name}] no data`);
    return;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);

  console.log(`\n[${name}]`);
  console.log(`  count: ${values.length}`);
  console.log(`  min:   ${min.toFixed(1)} ms`);
  console.log(`  p50:   ${p50?.toFixed(1)} ms`);
  console.log(`  p95:   ${p95?.toFixed(1)} ms`);
  console.log(`  max:   ${max.toFixed(1)} ms`);
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error(
      "Usage: node dist/SCRIPTS/analyze-agent-logs.js /path/to/log.jsonl"
    );
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const ragLatencies: number[] = [];
  const plannerLatencies: number[] = [];
  const answerLatencies: number[] = [];

  // Phase12 planner metrics
  type PlannerMetrics = {
    totalDialogs: number;
    ruleBasedCount: number;
    ruleBasedByIntent: Record<string, number>;
    plannerLlmCount: number;
    plannerLlmByRoute: Record<string, number>;
    fastPathCount: number;
  };

  const plannerMetrics: PlannerMetrics = {
    totalDialogs: 0,
    ruleBasedCount: 0,
    ruleBasedByIntent: {},
    plannerLlmCount: 0,
    plannerLlmByRoute: {},
    fastPathCount: 0,
  };

  type PlannerLlmCallSample = {
    route: string;
    conversationId?: string;
    userMessagePreview?: string;
    model?: string;
  };

  const plannerLlmCalls: PlannerLlmCallSample[] = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // skip non-JSON lines
      continue;
    }

    // dialog.rag.finished -> totalMs
    if (obj.msg === "dialog.rag.finished" && typeof obj.totalMs === "number") {
      ragLatencies.push(obj.totalMs);
    }

    // planner logs -> latencyMs
    if (obj.tag === "planner" && typeof obj.latencyMs === "number") {
      plannerLatencies.push(obj.latencyMs);
    }

    // answer logs -> latencyMs
    if (
      obj.msg === "dialog.answer.finished" &&
      typeof obj.latencyMs === "number"
    ) {
      answerLatencies.push(obj.latencyMs);
    }

    // Phase12 Planner Metrics
    const msg = obj.msg;
    if (msg === "dialog.run.start") {
      plannerMetrics.totalDialogs += 1;
    }

    if (msg === "dialog.planner.rule-based") {
      plannerMetrics.ruleBasedCount += 1;
      const intent = typeof obj.intentHint === "string" ? obj.intentHint : "unknown";
      plannerMetrics.ruleBasedByIntent[intent] =
        (plannerMetrics.ruleBasedByIntent[intent] ?? 0) + 1;
    }

    if (msg === "planner.prompt") {
      plannerMetrics.plannerLlmCount += 1;
      const route = typeof obj.route === "string" ? obj.route : "unknown";
      plannerMetrics.plannerLlmByRoute[route] =
        (plannerMetrics.plannerLlmByRoute[route] ?? 0) + 1;

      plannerLlmCalls.push({
        route,
        conversationId:
          typeof obj.conversationId === "string"
            ? obj.conversationId
            : undefined,
        userMessagePreview:
          typeof obj.userMessagePreview === "string"
            ? obj.userMessagePreview
            : undefined,
        model: typeof obj.model === "string" ? obj.model : undefined,
      });
    }

    if (msg === "dialog.run.fast-path") {
      plannerMetrics.fastPathCount += 1;
    }
  }

  console.log("=== Agent latency stats (from logs) ===");
  summarize("RAG totalMs (dialog.rag.finished)", ragLatencies);
  summarize("Planner latencyMs (tag=planner)", plannerLatencies);
  summarize(
    "Answer latencyMs (dialog.answer.finished)",
    answerLatencies,
  );

  function pct(num: number, den: number): string {
    return den > 0 ? ((num / den) * 100).toFixed(1) : "0.0";
  }

  console.log("\n=== Planner Metrics (Phase12) ===");
  console.log(`total dialogs            : ${plannerMetrics.totalDialogs}`);
  console.log(
    `rule-based planner used  : ${plannerMetrics.ruleBasedCount} (${pct(
      plannerMetrics.ruleBasedCount,
      plannerMetrics.totalDialogs,
    )}%)`,
  );
  console.log(
    `planner LLM calls        : ${plannerMetrics.plannerLlmCount} (${pct(
      plannerMetrics.plannerLlmCount,
      plannerMetrics.totalDialogs,
    )}%)`,
  );
  console.log(
    `fast-path answers        : ${plannerMetrics.fastPathCount} (${pct(
      plannerMetrics.fastPathCount,
      plannerMetrics.totalDialogs,
    )}%)`,
  );

  console.log("\n- Rule-based by intent:");
  for (const [intent, count] of Object.entries(plannerMetrics.ruleBasedByIntent)) {
    console.log(`  ${intent}: ${count} (${pct(count, plannerMetrics.ruleBasedCount)}%)`);
  }

  console.log("\n- Planner LLM by route:");
  for (const [route, count] of Object.entries(plannerMetrics.plannerLlmByRoute)) {
    console.log(`  ${route}: ${count} (${pct(count, plannerMetrics.plannerLlmCount)}%)`);
  }

  if (plannerLlmCalls.length > 0) {
    console.log("\n- Planner LLM call samples:");
    plannerLlmCalls.forEach((c, idx) => {
      const msgPreview = c.userMessagePreview
        ? c.userMessagePreview.replace(/\s+/g, " ")
        : "(no preview)";
      console.log(
        `  ${idx + 1}. route=${c.route}, model=${c.model ?? "unknown"}, conversationId=${c.conversationId ?? "n/a"}`,
      );
      console.log(`     userMessage="${msgPreview.slice(0, 80)}"`);
    });
  } else {
    console.log("\n- Planner LLM call samples: (none)");
  }

  console.log("=================================\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
