// SCRIPTS/create_all_md_context_zip.ts
//
// リポジトリ配下のすべての .md ファイルを 1 つの ZIP にまとめるスクリプト。
// - git 管理されている .md のみを対象にするため、`git ls-files '*.md'` を使用。
// - 生成されるファイル名: all-md-context-YYYYMMDD.zip
//
// 実行例:
//   pnpm ts-node SCRIPTS/create_all_md_context_zip.ts

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function buildZipName(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `all-md-context-${yyyy}${mm}${dd}.zip`;
}

async function listMarkdownFiles(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "*.md"]);
    const files = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return files;
  } catch (err) {
    console.error(
      "[create_all_md_context_zip] Failed to run `git ls-files '*.md'`."
    );
    console.error(err);
    process.exit(1);
  }
}

async function main() {
  const zipName = buildZipName();

  const mdFiles = await listMarkdownFiles();
  if (mdFiles.length === 0) {
    console.error(
      "[create_all_md_context_zip] No .md files found by git. Aborting."
    );
    process.exit(1);
  }

  console.log(`[create_all_md_context_zip] Found ${mdFiles.length} .md files.`);
  console.log(
    "[create_all_md_context_zip] First few files:\n" +
      mdFiles
        .slice(0, 10)
        .map((f) => `  - ${f}`)
        .join("\n")
  );

  // zip コマンド前提（macOS / Linux 想定）
  const args = ["-r", zipName, ...mdFiles];

  console.log(`\nRunning: zip ${args.join(" ")}`);

  try {
    const { stdout, stderr } = await execFileAsync("zip", args);
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    console.log(`\n[create_all_md_context_zip] Done. Generated ${zipName}`);
  } catch (err) {
    console.error("[create_all_md_context_zip] zip command failed.");
    console.error(err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
