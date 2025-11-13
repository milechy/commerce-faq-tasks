#!/usr/bin/env bash
set -euo pipefail

OUT_ZIP="${1:-$HOME/Desktop/commerce-faq-phase2-base.zip}"

echo "== Phase2 base ZIP を作成 =="
echo "  -> $OUT_ZIP"

command -v zip >/dev/null || { echo "zip コマンドが必要です"; exit 1; }

[ -f package.json ] || { echo "ここはリポジトリのルートではなさそうです"; exit 1; }

EXCLUDES=(
  "-x" "node_modules/*"
  "-x" "dist/*"
  "-x" "*.DS_Store"
  "-x" "logs/perf/*.json"
  "-x" "models/*.onnx"
)

zip -r "$OUT_ZIP" \
  .devcontainer \
  .env.example \
  .gitattributes \
  .github/workflows \
  Dockerfile docker-compose.yml \
  package.json pnpm-lock.yaml tsconfig.json \
  SCRIPTS TASKS.md README.md \
  src models/ce-export \
  logs/perf/summary.md logs/perf/.gitkeep \
  "${EXCLUDES[@]}"

echo "== 完了: $(du -h "$OUT_ZIP" | awk '{print $1}')"
echo "== 内容プレビュー（上位50件）"
unzip -l "$OUT_ZIP" | sed -n '1,50p'
