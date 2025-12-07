// SCRIPTS/convertSalesLogsCsvToJson.ts
// Phase15: Convert SalesLog CSV export to JSON (SalesLogRow[])
//
// Usage example:
//   npx ts-node SCRIPTS/convertSalesLogsCsvToJson.ts \
//     --input data/sales_logs.csv \
//     --output data/sales_logs.json
//
// Expected CSV headers (case-sensitive by default):
//   phase,intent,personaTags,templateId,templateSource
//
// - phase: "clarify" | "propose" | "recommend" | "close" | ...
// - intent: slug string (e.g. "trial_lesson_offer")
// - personaTags: comma-separated tags (e.g. "beginner,busy")
// - templateId: "notion:..." or "fallback:..." etc.
// - templateSource: "notion" | "fallback" (runtime SalesLogWriter output)

import fs from "node:fs";
import path from "node:path";

export type SalesPhase = "clarify" | "propose" | "recommend" | "close" | string;

export interface SalesLogRow {
  phase?: SalesPhase | null;
  intent?: string | null;
  personaTags?: string[] | null;
  templateId?: string | null;
  templateSource?: string | null; // "notion" | "fallback"
}

interface CliOptions {
  inputPath: string;
  outputPath: string;
}

function printUsage(): void {
  const scriptName = path.basename(__filename);
  // eslint-disable-next-line no-console
  console.log(
    `Usage: npx ts-node SCRIPTS/${scriptName} --input <sales_logs.csv> --output <sales_logs.json>`
  );
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2);
  let inputPath: string | undefined;
  let outputPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--input") {
      inputPath = args[i + 1];
      i++;
    } else if (arg === "--output") {
      outputPath = args[i + 1];
      i++;
    } else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    }
  }

  if (!inputPath || !outputPath) {
    printUsage();
    // eslint-disable-next-line no-console
    console.error(
      "[convertSalesLogsCsvToJson] --input と --output は必須です。"
    );
    process.exit(1);
  }

  return { inputPath, outputPath };
}

function loadCsv(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    // eslint-disable-next-line no-console
    console.error(`[convertSalesLogsCsvToJson] file not found: ${filePath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  result.push(current);
  return result.map((v) => v.trim());
}

function splitPersonaTags(raw: string): string[] | null {
  const value = raw.trim();
  if (!value) return null;

  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  return parts.length > 0 ? parts : null;
}

function convertCsvToSalesLogs(lines: string[]): SalesLogRow[] {
  if (lines.length === 0) {
    return [];
  }

  const header = parseCsvLine(lines[0]);

  const idxPhase = header.indexOf("phase");
  const idxIntent = header.indexOf("intent");
  const idxPersonaTags = header.indexOf("personaTags");
  const idxTemplateId = header.indexOf("templateId");
  const idxTemplateSource = header.indexOf("templateSource");

  if (
    idxPhase === -1 ||
    idxIntent === -1 ||
    idxPersonaTags === -1 ||
    idxTemplateId === -1 ||
    idxTemplateSource === -1
  ) {
    // eslint-disable-next-line no-console
    console.error(
      "[convertSalesLogsCsvToJson] CSV must contain headers: phase,intent,personaTags,templateId,templateSource"
    );
    process.exit(1);
  }

  const rows: SalesLogRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    if (row.length === 1 && row[0] === "") continue;

    const phaseRaw = row[idxPhase] ?? "";
    const intentRaw = row[idxIntent] ?? "";
    const personaRaw = row[idxPersonaTags] ?? "";
    const templateIdRaw = row[idxTemplateId] ?? "";
    const templateSourceRaw = row[idxTemplateSource] ?? "";

    const phase = phaseRaw.trim() || null;
    const intent = intentRaw.trim() || null;
    const personaTags = splitPersonaTags(personaRaw);
    const templateId = templateIdRaw.trim() || null;
    const templateSource = templateSourceRaw.trim() || null;

    // phase / intent / templateId / templateSource が完全に空の行はスキップ（ヘッダ下の空行など）
    if (!phase && !intent && !templateId && !templateSource) {
      // eslint-disable-next-line no-console
      console.warn(
        `[convertSalesLogsCsvToJson] skip row ${
          i + 1
        }: empty phase/intent/templateId/templateSource: ${lines[i]}`
      );
      continue;
    }

    rows.push({
      phase,
      intent,
      personaTags,
      templateId,
      templateSource,
    });
  }

  return rows;
}

function saveJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, json, "utf8");
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv);
  const lines = loadCsv(cli.inputPath);
  const logs = convertCsvToSalesLogs(lines);

  saveJson(cli.outputPath, logs);

  // eslint-disable-next-line no-console
  console.log(
    `[convertSalesLogsCsvToJson] wrote ${logs.length} rows to ${cli.outputPath}`
  );
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main();
}
