#!/usr/bin/env bash
set -euo pipefail

# 使い方:
#   ./tools/zip-md.sh
#   OUT=md-only.zip ./tools/zip-md.sh
#   ROOT=docs OUT=docs-md.zip ./tools/zip-md.sh
#
# 前提:
# - git 管理のリポジトリ上で実行
# - macOS/Linux を想定

ROOT="${ROOT:-.}"
OUT="${OUT:-md-only.zip}"

# Gitリポジトリ判定
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[ERROR] git repo ではありません（git rev-parse 失敗）" >&2
  exit 1
fi

# 既存ZIPがあれば上書き
rm -f "$OUT"

# .md を Git 管理下から抽出（推奨：ノイズが入らない）
# - 追跡ファイルのみ対象
# - 大文字拡張子 (.MD) も拾う
mapfile -t FILES < <(
  git ls-files "$ROOT" \
    | awk 'tolower($0) ~ /\.md$/'
)

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "[WARN] 対象の .md が見つかりませんでした（ROOT=$ROOT）" >&2
  exit 0
fi

echo "[INFO] zipping ${#FILES[@]} markdown files -> $OUT"

# zip は -@ でstdinからファイル一覧を受ける
printf "%s\n" "${FILES[@]}" | zip -q -@ "$OUT"

echo "[OK] created: $OUT"
echo "[INFO] file list:"
zipinfo -1 "$OUT"