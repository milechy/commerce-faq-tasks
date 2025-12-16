// SCRIPTS/create_phase17_context_zip.ts
//
// Phase17 用のコンテキスト ZIP を生成するスクリプト。
// 「Phase17 の開発サポートに必要なファイル・ディレクトリ」をまとめて
// phase17-context-YYYYMMDD.zip に固める。
//
// 実行例:
//   pnpm ts-node SCRIPTS/create_phase17_context_zip.ts

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function buildZipName(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `phase17-context-${yyyy}${mm}${dd}.zip`;
}

// Phase17 でサポートに使いたいファイル・ディレクトリ。
// すべてリポジトリルートからの相対パス。
//
// - コア概要/設計
// - RAG / Sales 関連の agent コード
// - tests/agent
// - SCRIPTS / config / data / reports / logs/perf
// - 過去コンテキスト (phase12 / phase7 minimal)
const INCLUDED_PATHS: string[] = [
  // プロジェクト概要・アーキテクチャ
  "README_PROJECT.md",
  "README.md",
  "REQUIREMENTS.md",
  "ARCHITECTURE.md",
  "DEV_ARCHITECTURE.md",
  "AGENTS.md",
  "jest.config.cjs",
  "package.json",
  "pnpm-lock.yaml",

  // ドキュメント一式（.md は GPT プロジェクトにもあるが、正準スナップショットとして残す）
  "docs",

  // 設定
  "config",

  // エージェント実装
  "src/agent/dialog",
  "src/agent/flow",
  "src/agent/orchestrator",
  "src/agent/http",
  "src/agent/crew",

  // テスト
  "tests/agent",

  // スクリプト（分析・コンテキスト生成など）
  "SCRIPTS",

  // データ・レポート・パフォーマンスログ
  "data",
  "reports",
  "logs/perf",

  // 過去フェーズのコンテキスト（RAG / Sales の歴史を参照するため）
  "phase12-context",
  "phase12-context 2",
  "commerce-faq-phase7-minimal",
];

async function main() {
  const zipName = buildZipName();

  // 存在チェック（消えているものは警告だけ出してスキップ）
  const existingPaths = INCLUDED_PATHS.filter((p) => existsSync(p));
  const missingPaths = INCLUDED_PATHS.filter((p) => !existsSync(p));

  if (missingPaths.length > 0) {
    console.warn(
      "[create_phase17_context_zip] Warning: some paths do not exist and will be skipped:\n" +
        missingPaths.map((p) => `  - ${p}`).join("\n")
    );
  }

  if (existingPaths.length === 0) {
    console.error(
      "[create_phase17_context_zip] No existing paths to include. Check INCLUDED_PATHS."
    );
    process.exit(1);
  }

  const args = ["-r", zipName, ...existingPaths];

  console.log(`[create_phase17_context_zip] Running: zip ${args.join(" ")}`);

  try {
    const { stdout, stderr } = await execFileAsync("zip", args);
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    console.log(`\n[create_phase17_context_zip] Done. Generated ${zipName}`);
  } catch (err) {
    console.error("[create_phase17_context_zip] zip command failed.");
    console.error(err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
