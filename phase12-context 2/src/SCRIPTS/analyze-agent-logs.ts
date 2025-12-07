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
  }

  console.log("=== Agent latency stats (from logs) ===");
  summarize("RAG totalMs (dialog.rag.finished)", ragLatencies);
  summarize("Planner latencyMs (tag=planner)", plannerLatencies);
  summarize(
    "Answer latencyMs (dialog.answer.finished)",
    answerLatencies,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
