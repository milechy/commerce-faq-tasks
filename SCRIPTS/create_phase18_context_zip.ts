// SCRIPTS/create_phase18_context_zip.ts
import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist-zips");

const includePaths = [
  "src/index.ts",
  "src/search",
  "src/agent",
  "SCRIPTS/bench-agent-search.ts",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "PHASE17_SUMMARY.md",
  "docs/search-pipeline.md",
  "docs/P95_METRICS.md",
  "docs/LOGGING_SCHEMA.md",
];

function main() {
  const zip = new AdmZip();
  for (const p of includePaths) {
    const full = path.join(ROOT, p);
    if (!fs.existsSync(full)) continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      zip.addLocalFolder(full, p);
    } else {
      zip.addLocalFile(full, path.dirname(p));
    }
  }

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);
  const date = new Date();
  const ymd = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("");
  const outPath = path.join(OUT_DIR, `phase18-context-${ymd}.zip`);
  zip.writeZip(outPath);
  console.log("wrote", outPath);
}

main();
