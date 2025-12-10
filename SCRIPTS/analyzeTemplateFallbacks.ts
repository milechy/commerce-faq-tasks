// SCRIPTS/analyzeTemplateFallbacks.ts
// Phase15: Analyze how often each (phase, intent, personaTag) cell falls back
// to hard-coded templates instead of Notion templates.
//
// Usage (example):
//   npx ts-node SCRIPTS/analyzeTemplateFallbacks.ts \
//     --matrix data/template_matrix.json \
//     --logs data/sales_logs.json
//
// 前提:
// - JSON ファイルを入力として扱う（Notion API には直接アクセスしない）
// - matrix には intent x persona の期待テンプレ有無が入っている
// - logs には SalesLog の実績（templateId, personaTags, phase, intent）が入っている
//
// これにより、TemplateMatrix / TemplateGaps で想定したカバレッジと、
// 実際に fallback に落ちているセルを突き合わせて分析できる。

import fs from "node:fs";
import path from "node:path";

// SalesFlow のフェーズ。将来拡張も考慮して string を許容しておく。
export type SalesPhase = "clarify" | "propose" | "recommend" | "close" | string;

// TemplateMatrix 側の 1 セルを表す型
export interface MatrixCell {
  phase: SalesPhase;
  intent: string;
  personaTag: string; // 例: "beginner" | "business" | "ANY" など
  hasTemplate: boolean;
}

// SalesLog 側の 1 行を表す型（必要なフィールドのみ）
export interface SalesLogRow {
  phase?: SalesPhase | null;
  intent?: string | null;
  personaTags?: string[] | null;
  templateId?: string | null;
}

export type CellKey = string; // `${phase}|${intent}|${personaTag}`

export interface CellStats {
  total: number;
  fallback: number;
  nonFallback: number;
}

export type CellStatus =
  | "OK_NOTION"
  | "OK_EXPECTED_FALLBACK"
  | "NG_FALLBACK_SHOULD_HAVE_TEMPLATE"
  | "NG_NOTION_ON_MISSING_CELL"
  | "UNUSED_CELL"
  | "UNKNOWN_MATRIX";

export interface AnalyzedCell extends CellStats {
  phase: SalesPhase;
  intent: string;
  personaTag: string;
  matrixHasTemplate: boolean | null;
  status: CellStatus;
}

interface CliOptions {
  matrixPath: string;
  logsPath: string;
}

function printUsage(): void {
  const scriptName = path.basename(__filename);
  // eslint-disable-next-line no-console
  console.log(
    `Usage: npx ts-node SCRIPTS/${scriptName} --matrix <matrix.json> --logs <sales_logs.json>`
  );
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2); // remove node + script

  let matrixPath: string | undefined;
  let logsPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--matrix") {
      matrixPath = args[i + 1];
      i++;
    } else if (arg === "--logs") {
      logsPath = args[i + 1];
      i++;
    } else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    }
  }

  if (!matrixPath || !logsPath) {
    printUsage();
    // eslint-disable-next-line no-console
    console.error("[analyzeTemplateFallbacks] --matrix と --logs は必須です。");
    process.exit(1);
  }

  return { matrixPath, logsPath };
}

function loadJsonArray<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    // eslint-disable-next-line no-console
    console.error(`[analyzeTemplateFallbacks] file not found: ${filePath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[analyzeTemplateFallbacks] failed to parse JSON: ${filePath}`,
      error
    );
    process.exit(1);
  }

  if (!Array.isArray(parsed)) {
    // eslint-disable-next-line no-console
    console.error(
      `[analyzeTemplateFallbacks] JSON must be an array: ${filePath}`
    );
    process.exit(1);
  }

  return parsed as T[];
}

function normalizeCellKey(
  phase: string,
  intent: string,
  personaTag: string
): CellKey {
  return `${phase}|${intent}|${personaTag}`;
}

function pickPersonaTagForCell(
  personaTags: string[] | null | undefined
): string {
  if (!personaTags || personaTags.length === 0) {
    return "ANY";
  }
  return personaTags[0];
}

function isFallbackTemplate(templateId: string | null | undefined): boolean {
  if (!templateId) return false;
  return templateId.startsWith("fallback:");
}

function analyzeFallbacks(
  matrix: MatrixCell[],
  logs: SalesLogRow[]
): AnalyzedCell[] {
  const matrixMap = new Map<CellKey, MatrixCell>();
  for (const cell of matrix) {
    const key = normalizeCellKey(cell.phase, cell.intent, cell.personaTag);
    matrixMap.set(key, cell);
  }

  const statsMap = new Map<CellKey, CellStats>();

  const touchStats = (key: CellKey): CellStats => {
    const existing = statsMap.get(key);
    if (existing) return existing;
    const fresh: CellStats = { total: 0, fallback: 0, nonFallback: 0 };
    statsMap.set(key, fresh);
    return fresh;
  };

  // 1) SalesLog から実績を集計
  for (const row of logs) {
    const phase = row.phase;
    const intent = row.intent;

    if (!phase || !intent) {
      continue; // フェーズ or intent 不明なログはスキップ
    }

    const personaTag = pickPersonaTagForCell(row.personaTags);
    const key = normalizeCellKey(phase, intent, personaTag);
    const stats = touchStats(key);

    stats.total += 1;
    if (isFallbackTemplate(row.templateId)) {
      stats.fallback += 1;
    } else {
      stats.nonFallback += 1;
    }
  }

  // 2) Matrix 側のセルも statsMap に必ず載るようにする（未使用セルも把握したい）
  for (const cell of matrix) {
    const key = normalizeCellKey(cell.phase, cell.intent, cell.personaTag);
    touchStats(key);
  }

  // 3) 各セルのステータスを判定
  const analyzed: AnalyzedCell[] = [];

  for (const [key, stats] of statsMap.entries()) {
    const [phase, intent, personaTag] = key.split("|");
    const matrixCell = matrixMap.get(key) ?? null;
    const matrixHasTemplate = matrixCell ? matrixCell.hasTemplate : null;

    let status: CellStatus;

    if (stats.total === 0) {
      if (matrixHasTemplate === true || matrixHasTemplate === false) {
        status = "UNUSED_CELL";
      } else {
        status = "UNKNOWN_MATRIX";
      }
    } else if (matrixHasTemplate === true) {
      if (stats.fallback > 0) {
        status = "NG_FALLBACK_SHOULD_HAVE_TEMPLATE";
      } else {
        status = "OK_NOTION";
      }
    } else if (matrixHasTemplate === false) {
      if (stats.nonFallback > 0) {
        status = "NG_NOTION_ON_MISSING_CELL";
      } else {
        status = "OK_EXPECTED_FALLBACK";
      }
    } else {
      status = "UNKNOWN_MATRIX";
    }

    analyzed.push({
      phase,
      intent,
      personaTag,
      matrixHasTemplate,
      status,
      total: stats.total,
      fallback: stats.fallback,
      nonFallback: stats.nonFallback,
    });
  }

  // フェーズ -> intent -> personaTag の順で並べ替え
  analyzed.sort((a, b) => {
    if (a.phase !== b.phase) return a.phase.localeCompare(b.phase);
    if (a.intent !== b.intent) return a.intent.localeCompare(b.intent);
    if (a.personaTag !== b.personaTag)
      return a.personaTag.localeCompare(b.personaTag);
    return 0;
  });

  return analyzed;
}

function buildMarkdownReport(cells: AnalyzedCell[], opts: CliOptions): string {
  const lines: string[] = [];

  lines.push("# Template Fallback Analysis");
  lines.push("");
  lines.push(`- Matrix file: ${opts.matrixPath}`);
  lines.push(`- Logs file: ${opts.logsPath}`);
  lines.push(`- Generated at: ${new Date().toISOString()}`);
  lines.push("");

  const totalCells = cells.length;
  const totalHits = cells.reduce((acc, c) => acc + c.total, 0);
  const totalFallbackHits = cells.reduce((acc, c) => acc + c.fallback, 0);

  lines.push("## Summary");
  lines.push("");
  lines.push(`- Cells: ${totalCells}`);
  lines.push(`- Total hits: ${totalHits}`);
  lines.push(`- Fallback hits: ${totalFallbackHits}`);
  lines.push("");

  lines.push("## Per-cell Detail");
  lines.push("");
  lines.push(
    "| Phase | Intent | PersonaTag | MatrixHasTemplate | Hits | FallbackHits | NonFallbackHits | Status |"
  );
  lines.push(
    "|-------|--------|-----------|-------------------|------:|-------------:|----------------:|--------|"
  );

  for (const cell of cells) {
    const matrixFlag =
      cell.matrixHasTemplate === null
        ? "(unknown)"
        : cell.matrixHasTemplate
        ? "YES"
        : "NO";

    lines.push(
      `| ${cell.phase} | ${cell.intent} | ${cell.personaTag} | ${matrixFlag} | ${cell.total} | ${cell.fallback} | ${cell.nonFallback} | ${cell.status} |`
    );
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv);

  const matrix = loadJsonArray<MatrixCell>(cli.matrixPath);
  const logs = loadJsonArray<SalesLogRow>(cli.logsPath);

  const analyzed = analyzeFallbacks(matrix, logs);
  const markdown = buildMarkdownReport(analyzed, cli);

  // eslint-disable-next-line no-console
  console.log(markdown);
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main();
}
