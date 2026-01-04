// SCRIPTS/bench-agent-search.ts
import { setTimeout as sleep } from "node:timers/promises";

// Node18+ なら fetch はグローバルに存在する
const ENDPOINT = process.env.ENDPOINT ?? "http://localhost:3100/search.v1";
const N = Number(process.env.N ?? 100);

const queries = [
  "送料と支払い方法について教えてください",
  "返品ポリシーについて教えてください",
  "北海道への配送は可能ですか？",
  "クレジットカード以外の決済方法はありますか？",
];

type Sample = {
  latency: number;
  search_ms?: number;
  rerank_ms?: number;
  total_ms?: number;
};

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

async function main() {
  const samples: Sample[] = [];

  for (let i = 0; i < N; i++) {
    const body = {
      q: queries[i % queries.length],
      topK: 8,
    };

    const t0 = Date.now();
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    const t1 = Date.now();

    const ce_ms = typeof json.ce_ms === "number" ? json.ce_ms : undefined;

    const metaRagStats = json.meta?.ragStats;

    let search_ms: number | undefined;
    let rerank_ms: number | undefined;
    let total_ms: number | undefined;

    if (metaRagStats && typeof metaRagStats === "object") {
      const s = metaRagStats as {
        search_ms?: unknown;
        rerank_ms?: unknown;
        total_ms?: unknown;
      };

      search_ms =
        typeof s.search_ms === "number" ? (s.search_ms as number) : undefined;
      rerank_ms =
        typeof s.rerank_ms === "number" ? (s.rerank_ms as number) : undefined;
      total_ms =
        typeof s.total_ms === "number" ? (s.total_ms as number) : undefined;
    }

    if (
      search_ms === undefined &&
      rerank_ms === undefined &&
      total_ms === undefined
    ) {
      if (ce_ms !== undefined) {
        rerank_ms = ce_ms;
        total_ms = ce_ms;
      }
    }

    if (
      search_ms === undefined &&
      rerank_ms === undefined &&
      total_ms === undefined
    ) {
      const debug = json.debug ?? {};
      const search = debug.search ?? {};
      const rerank = debug.rerank ?? {};

      search_ms = typeof search.ms === "number" ? search.ms : undefined;
      rerank_ms = typeof rerank.ce_ms === "number" ? rerank.ce_ms : undefined;
      total_ms =
        typeof search_ms === "number" || typeof rerank_ms === "number"
          ? (search_ms ?? 0) + (rerank_ms ?? 0)
          : undefined;
    }

    samples.push({
      latency: t1 - t0,
      search_ms,
      rerank_ms,
      total_ms,
    });

    await sleep(10); // 軽い隙間
  }

  const lat = samples.map((s) => s.latency);
  const search = samples.map((s) => s.search_ms ?? 0);
  const rerank = samples.map((s) => s.rerank_ms ?? 0);
  const total = samples.map((s) => s.total_ms ?? 0);

  console.log("N =", samples.length);
  console.log("latency p50/p95:", percentile(lat, 50), percentile(lat, 95));
  console.log(
    "search_ms p50/p95:",
    percentile(search, 50),
    percentile(search, 95)
  );
  console.log(
    "rerank_ms p50/p95:",
    percentile(rerank, 50),
    percentile(rerank, 95)
  );
  console.log(
    "rag_total_ms p50/p95:",
    percentile(total, 50),
    percentile(total, 95)
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
