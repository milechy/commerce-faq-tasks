/* eslint-disable no-console */
/**
 * Sales KPI Funnel Analysis
 *
 * Usage:
 *   npx ts-node SCRIPTS/analyzeSalesKpiFunnel.ts \
 *     --logs data/sales_logs.json
 *
 * Outputs a Markdown report to stdout.
 *
 * このスクリプトは Phase15 で追加した SalesLogWriter の出力
 * (sales_logs.json) を元に、SalesFlow のステージ分布・遷移率などの
 * KPI を可視化するためのオフライン分析ツールです。
 */

import fs from "node:fs";

type Stage = "clarify" | "propose" | "recommend" | "close" | string;

type TemplateSource = "notion" | "fallback" | string;

interface SalesLogEntry {
  tenantId?: string;
  sessionId?: string;
  phase: Stage;
  intent?: string;
  personaTags?: string[];
  templateSource?: TemplateSource;
  templateId?: string | null;
  prevStage?: Stage | null;
  nextStage?: Stage | null;
  timestamp?: string;
  createdAt?: string;
  // その他のフィールドが存在しても良い
  [key: string]: unknown;
}

interface CliArgs {
  logsPath: string;
}

function parseArgs(argv: string[]): CliArgs {
  let logsPath = "data/sales_logs.json";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--logs" && i + 1 < argv.length) {
      logsPath = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    }
  }

  return { logsPath };
}

function printHelpAndExit(): never {
  console.log(
    [
      "Usage:",
      "  npx ts-node SCRIPTS/analyzeSalesKpiFunnel.ts --logs data/sales_logs.json",
      "",
      "Options:",
      "  --logs <path>   Path to sales logs JSON file (default: data/sales_logs.json)",
    ].join("\n")
  );
  process.exit(0);
}

function loadLogs(path: string): SalesLogEntry[] {
  if (!fs.existsSync(path)) {
    throw new Error(`[analyzeSalesKpiFunnel] file not found: ${path}`);
  }

  const raw = fs.readFileSync(path, "utf8");
  const data = JSON.parse(raw);

  if (!Array.isArray(data)) {
    throw new Error(
      `[analyzeSalesKpiFunnel] expected JSON array in ${path}, got ${typeof data}`
    );
  }

  return data as SalesLogEntry[];
}

function countBy<T extends string | number>(items: T[]): Map<T, number> {
  const m = new Map<T, number>();
  for (const item of items) {
    m.set(item, (m.get(item) ?? 0) + 1);
  }
  return m;
}

function formatPercent(numerator: number, denominator: number): string {
  if (!denominator) return "0.0%";
  const pct = (numerator / denominator) * 100;
  return `${pct.toFixed(1)}%`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const logs = loadLogs(args.logsPath);

  const generatedAt = new Date().toISOString();
  const total = logs.length;

  const sessionIds = new Set<string>();
  const tenantIds = new Set<string>();

  const stages: Stage[] = [];
  const transitions: { from: Stage; to: Stage }[] = [];
  const personaStagePairs: { tag: string; stage: Stage }[] = [];
  const intentEntries: { intent: string; templateSource?: TemplateSource }[] =
    [];

  for (const entry of logs) {
    if (entry.sessionId) sessionIds.add(entry.sessionId);
    if (entry.tenantId) tenantIds.add(entry.tenantId);

    const stage = entry.phase;
    stages.push(stage);

    // prevStage / nextStage があれば、それを元にステージ遷移を集計
    const from = entry.prevStage ?? null;
    const to = entry.nextStage ?? entry.phase;
    if (from && to) {
      transitions.push({ from, to });
    }

    const tags =
      entry.personaTags && entry.personaTags.length > 0
        ? entry.personaTags
        : ["UNKNOWN"];

    for (const tag of tags) {
      personaStagePairs.push({ tag, stage });
    }

    if (entry.intent) {
      intentEntries.push({
        intent: entry.intent,
        templateSource: entry.templateSource,
      });
    }
  }

  const stageCounts = countBy(stages);
  const transitionPairs = transitions.map((t) => `${t.from}->${t.to}`);
  const transitionCounts = countBy(transitionPairs);

  const personaTagCounts = countBy(personaStagePairs.map((p) => p.tag));
  const personaStageKeyCounts = countBy(
    personaStagePairs.map((p) => `${p.tag}::${p.stage}`)
  );

  const intentCounts = countBy(intentEntries.map((e) => e.intent));
  const intentFallbackCounts = new Map<string, number>();
  for (const e of intentEntries) {
    if (e.templateSource === "fallback") {
      intentFallbackCounts.set(
        e.intent,
        (intentFallbackCounts.get(e.intent) ?? 0) + 1
      );
    }
  }

  // Funnel 指標（clarify -> propose -> recommend -> close）を個別に抽出
  const funnelPairs: Array<{ from: Stage; to: Stage }> = [
    { from: "clarify", to: "propose" },
    { from: "propose", to: "recommend" },
    { from: "recommend", to: "close" },
  ];

  const funnelMetrics = funnelPairs.map(({ from, to }) => {
    const base = Array.from(transitionCounts.entries())
      .filter(([key]) => key.startsWith(`${from}->`))
      .reduce((sum, [, c]) => sum + c, 0);

    const count = transitionCounts.get(`${from}->${to}`) ?? 0;

    return {
      from,
      to,
      count,
      base,
      rate: base > 0 ? count / base : 0,
    };
  });

  // ---- Markdown 出力 ----

  console.log("# Sales KPI Funnel Analysis\n");
  console.log(`- Logs file: ${args.logsPath}`);
  console.log(`- Generated at: ${generatedAt}\n`);

  console.log("## Summary\n");
  console.log(`- Entries: ${total}`);
  console.log(
    `- Unique sessions: ${
      sessionIds.size > 0 ? sessionIds.size : "N/A (sessionId not provided)"
    }`
  );
  console.log(
    `- Unique tenants: ${
      tenantIds.size > 0 ? tenantIds.size : "N/A (tenantId not provided)"
    }`
  );
  console.log("");

  // Stage distribution
  console.log("## Stage Distribution\n");
  if (stageCounts.size === 0) {
    console.log("_No stage data_\n");
  } else {
    console.log("| Stage | Count | Ratio |");
    console.log("|-------|------:|------:|");
    for (const [stage, count] of Array.from(stageCounts.entries()).sort()) {
      const ratio = formatPercent(count, total);
      console.log(`| ${stage} | ${count} | ${ratio} |`);
    }
    console.log("");
  }

  // Stage transitions
  console.log("## Stage Transitions\n");
  if (transitionCounts.size === 0) {
    console.log(
      "_No transition data (prevStage / nextStage not present in logs)_\n"
    );
  } else {
    console.log("| From | To | Count |");
    console.log("|------|----|------:|");
    for (const [pair, count] of Array.from(transitionCounts.entries()).sort()) {
      const [from, to] = pair.split("->");
      console.log(`| ${from} | ${to} | ${count} |`);
    }
    console.log("");
  }

  // Funnel metrics
  console.log("## Funnel Metrics (clarify → propose → recommend → close)\n");
  if (transitionCounts.size === 0) {
    console.log("_No funnel data (no transitions recorded)_\n");
  } else {
    console.log("| From | To | Count | Base (from *) | Rate |");
    console.log("|------|----|------:|--------------:|-----:|");
    for (const m of funnelMetrics) {
      console.log(
        `| ${m.from} | ${m.to} | ${m.count} | ${m.base} | ${formatPercent(
          m.count,
          m.base || 0
        )} |`
      );
    }
    console.log("");
  }

  // PersonaTag breakdown
  console.log("## PersonaTag Breakdown\n");
  if (personaTagCounts.size === 0) {
    console.log("_No personaTag data_\n");
  } else {
    console.log(
      "| PersonaTag | Total | clarify | propose | recommend | close |"
    );
    console.log(
      "|-----------|------:|--------:|--------:|----------:|------:|"
    );

    const allTags = Array.from(personaTagCounts.keys()).sort();

    for (const tag of allTags) {
      const totalForTag = personaTagCounts.get(tag) ?? 0;
      const clarifyCount = personaStageKeyCounts.get(`${tag}::clarify`) ?? 0;
      const proposeCount = personaStageKeyCounts.get(`${tag}::propose`) ?? 0;
      const recommendCount =
        personaStageKeyCounts.get(`${tag}::recommend`) ?? 0;
      const closeCount = personaStageKeyCounts.get(`${tag}::close`) ?? 0;

      console.log(
        `| ${tag} | ${totalForTag} | ${clarifyCount} | ${proposeCount} | ${recommendCount} | ${closeCount} |`
      );
    }

    console.log("");
  }

  // Intent breakdown
  console.log("## Intent Breakdown\n");
  if (intentCounts.size === 0) {
    console.log("_No intent data_\n");
  } else {
    console.log("| Intent | Count | FallbackCount | FallbackRate |");
    console.log("|--------|------:|--------------:|-------------:|");

    const allIntents = Array.from(intentCounts.keys()).sort();
    for (const intent of allIntents) {
      const count = intentCounts.get(intent) ?? 0;
      const fallbackCount = intentFallbackCounts.get(intent) ?? 0;
      console.log(
        `| ${intent} | ${count} | ${fallbackCount} | ${formatPercent(
          fallbackCount,
          count || 0
        )} |`
      );
    }

    console.log("");
  }
}

try {
  main();
} catch (err) {
  console.error("[analyzeSalesKpiFunnel] failed:", err);
  process.exit(1);
}
