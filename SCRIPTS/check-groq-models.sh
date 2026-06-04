#!/usr/bin/env bash
# SCRIPTS/check-groq-models.sh
# EOL 検知層: Groq が decommission 済みのモデル ID が src/ (非 test) に混入していないか走査する。
# 廃止モデルの実 ID 一覧は src/config/groqModels.ts#KNOWN_DEPRECATED_GROQ_MODELS が単一の真実。
# 1件でも見つかれば file:line を表示して exit 1（CI / security-scan から呼べる）。
#
# 使い方: bash SCRIPTS/check-groq-models.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CATALOG="$ROOT/src/config/groqModels.ts"

if [[ ! -f "$CATALOG" ]]; then
  echo "[check-groq-models] catalog not found: $CATALOG" >&2
  exit 2
fi

# KNOWN_DEPRECATED_GROQ_MODELS 配列のリテラル ('...' で始まる行) を抽出する。
# 配列ブロック内の 'xxx', 行だけを拾うため、定数名で範囲を絞ってから quote 内を抜く。
# 宣言行 (`... string[] = [`) は型注釈の `]` を含むため `next` でスキップし、
# 終端は単独の `] as const` 行で判定する。中身の 'xxx' リテラルだけを抜く。
mapfile -t DEPRECATED < <(
  awk '/KNOWN_DEPRECATED_GROQ_MODELS/{f=1; next} f && /^\] as const/{f=0} f' "$CATALOG" \
    | grep -oE "'[^']+'" | tr -d "'" | grep -vE '^$'
)

if [[ ${#DEPRECATED[@]} -eq 0 ]]; then
  echo "[check-groq-models] no deprecated IDs parsed from catalog (nothing to enforce)."
  exit 0
fi

echo "[check-groq-models] scanning src/ for ${#DEPRECATED[@]} deprecated Groq model IDs..."

FOUND=0
for id in "${DEPRECATED[@]}"; do
  # src/ 配下の .ts のうち test とカタログ自身を除外して固定文字列検索。
  HITS=$(grep -rn --include='*.ts' -F "$id" "$ROOT/src" 2>/dev/null \
    | grep -v '\.test\.ts' \
    | grep -v 'src/config/groqModels.ts' || true)
  if [[ -n "$HITS" ]]; then
    echo "----- DEPRECATED MODEL IN USE: $id -----"
    echo "$HITS"
    FOUND=1
  fi
done

if [[ "$FOUND" -eq 1 ]]; then
  echo ""
  echo "[check-groq-models] FAIL — decommissioned Groq model(s) referenced in src/."
  echo "  Migrate to an ACTIVE_GROQ_MODELS constant in src/config/groqModels.ts."
  exit 1
fi

echo "[check-groq-models] PASS — no deprecated Groq model IDs in src/."
exit 0
