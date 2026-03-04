// SCRIPTS/convertTemplateMatrixCsvToJson.ts
// Phase15: Convert TemplateMatrix CSV to JSON (MatrixCell[])
//
// Usage example:
//   npx ts-node SCRIPTS/convertTemplateMatrixCsvToJson.ts \
//     --input data/template_matrix.csv \
//     --output data/template_matrix.json
//
// Expected CSV headers (case-sensitive by default):
//   phase,intent,personaTag,hasTemplate
//
// - phase: "clarify" | "propose" | "recommend" | "close" | ...
// - intent: slug string (e.g. "trial_lesson_offer")
// - personaTag: persona tag or "ANY"
// - hasTemplate: "1" / "0" / "true" / "false" / "yes" / "no" (case-insensitive)

import fs from "node:fs";
import path from "node:path";

export type SalesPhase = "clarify" | "propose" | "recommend" | "close" | string;

export interface MatrixCell {
  phase: SalesPhase;
  intent: string;
  personaTag: string;
  hasTemplate: boolean;
}

interface CliOptions {
  inputPath: string;
  outputPath: string;
}

function printUsage(): void {
  const scriptName = path.basename(__filename);
  // eslint-disable-next-line no-console
  console.log(
    `Usage: npx ts-node SCRIPTS/${scriptName} --input <matrix.csv> --output <matrix.json>`
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
    console.error("[convertTemplateMatrixCsvToJson] --input と --output は必須です。");
    process.exit(1);
  }

  return { inputPath, outputPath };
}

function loadCsv(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    // eslint-disable-next-line no-console
    console.error(`[convertTemplateMatrixCsvToJson] file not found: ${filePath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split(/\r?\n/) // CRLF / LF
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseCsvLine(line: string): string[] {
  // シンプルな CSV パーサ: ダブルクオートを考慮
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // エスケープされた "
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

function parseBoolean(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "y") return true;
  if (v === "0" || v === "false" || v === "no" || v === "n") return false;
  // デフォルトは false に倒すが、ログは出しておく
  if (v.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[convertTemplateMatrixCsvToJson] unknown boolean value for hasTemplate: "${value}". Treat as false.`
    );
  }
  return false;
}

function convertCsvToMatrixCells(lines: string[]): MatrixCell[] {
  if (lines.length === 0) {
    return [];
  }

  const header = parseCsvLine(lines[0]);

  const idxPhase = header.indexOf("phase");
  const idxIntent = header.indexOf("intent");
  const idxPersona = header.indexOf("personaTag");
  const idxHasTemplate = header.indexOf("hasTemplate");

  if (idxPhase === -1 || idxIntent === -1 || idxPersona === -1 || idxHasTemplate === -1) {
    // eslint-disable-next-line no-console
    console.error(
      "[convertTemplateMatrixCsvToJson] CSV must contain headers: phase,intent,personaTag,hasTemplate"
    );
    process.exit(1);
  }

  const cells: MatrixCell[] = [];

  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    if (row.length === 1 && row[0] === "") continue;

    const phase = (row[idxPhase] ?? "").trim();
    const intent = (row[idxIntent] ?? "").trim();
    const personaTag = (row[idxPersona] ?? "").trim() || "ANY";
    const hasTemplateRaw = (row[idxHasTemplate] ?? "").trim();

    if (!phase || !intent) {
      // eslint-disable-next-line no-console
      console.warn(
        `[convertTemplateMatrixCsvToJson] skip row ${i + 1}: missing phase or intent: ${lines[i]}`
      );
      continue;
    }

    const hasTemplate = parseBoolean(hasTemplateRaw);

    cells.push({
      phase,
      intent,
      personaTag,
      hasTemplate,
    });
  }

  return cells;
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
  const cells = convertCsvToMatrixCells(lines);

  saveJson(cli.outputPath, cells);

  // eslint-disable-next-line no-console
  console.log(
    `[convertTemplateMatrixCsvToJson] wrote ${cells.length} cells to ${cli.outputPath}`
  );
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main();
}
