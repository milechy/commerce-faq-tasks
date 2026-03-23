#!/usr/bin/env bash
# =============================================================================
# build-widget.sh — Widget ビルド・最適化・難読化・バージョニング
#
# 使い方:
#   bash SCRIPTS/build-widget.sh [VERSION]
#
# 引数:
#   VERSION  バージョン文字列（省略時: "1.0.0"）
#
# 出力:
#   public/widget.min.js          — 難読化済みプロダクションビルド
#   dist/widget/widget.js         — オリジナルコピー（開発用）
#   dist/widget/widget.v<VER>.js  — バージョン付きコピー
#   dist/widget/widget.v<VER>.min.js — Minify版
#   dist/widget/widget.v<VER>.min.js.gz — gzip事前圧縮版
#   dist/widget/widget.latest.min.js — 最新版へのシンボリックリンク
#
# 依存ツール:
#   - terser: pnpm add -D terser
#   - javascript-obfuscator: pnpm add -D javascript-obfuscator
#   - gzip: 標準ツール
# =============================================================================

set -euo pipefail

VERSION="${1:-1.0.0}"
SRC="public/widget.js"
DIST="dist/widget"

echo "=== Widget Build: v${VERSION} ==="

# ---------------------------------------------------------------------------
# 前提チェック
# ---------------------------------------------------------------------------

if [[ ! -f "${SRC}" ]]; then
  echo "ERROR: ${SRC} が見つかりません。リポジトリルートで実行してください。"
  exit 1
fi

# 出力ディレクトリを作成
mkdir -p "${DIST}"

# ---------------------------------------------------------------------------
# 1. オリジナルをコピー（開発用）
# ---------------------------------------------------------------------------

cp "${SRC}" "${DIST}/widget.js"
echo "[1/5] コピー完了: ${DIST}/widget.js"

# ---------------------------------------------------------------------------
# 2. バージョン付きコピー
# ---------------------------------------------------------------------------

cp "${SRC}" "${DIST}/widget.v${VERSION}.js"
echo "[2/5] バージョン付きコピー: ${DIST}/widget.v${VERSION}.js"

# ---------------------------------------------------------------------------
# 3. Minify（terser → uglify-js の順でフォールバック）
# ---------------------------------------------------------------------------

MINIFIED="${DIST}/widget.v${VERSION}.min.js"

# バナーコメント（CDNキャッシュに含めるバージョン情報）
BANNER="/* RAJIUCE FAQ Widget v${VERSION} | (c) $(date +%Y) RAJIUCE | MIT */"

if command -v terser &>/dev/null; then
  echo "[3/5] Minify (terser)..."
  terser "${SRC}" \
    --compress \
      drop_console=false,pure_getters=true,unsafe=false \
    --mangle \
    --comments false \
    --output "${MINIFIED}"
  # バナーを先頭に追加
  TMPFILE=$(mktemp)
  echo "${BANNER}" > "${TMPFILE}"
  cat "${MINIFIED}" >> "${TMPFILE}"
  mv "${TMPFILE}" "${MINIFIED}"
  echo "    → terser 完了"

elif command -v uglifyjs &>/dev/null; then
  echo "[3/5] Minify (uglify-js)..."
  uglifyjs "${SRC}" \
    --compress \
    --mangle \
    --output "${MINIFIED}" \
    --preamble "${BANNER}"
  echo "    → uglify-js 完了"

else
  echo "[3/5] WARNING: terser も uglify-js も見つかりません。コピーのみ実行します。"
  echo "      インストール: pnpm add -D terser"
  cp "${SRC}" "${MINIFIED}"
fi

echo "    Minified: ${MINIFIED}"

# ---------------------------------------------------------------------------
# 4. 難読化 (javascript-obfuscator) → public/widget.min.js
# ---------------------------------------------------------------------------

echo "[4/5] Obfuscation (javascript-obfuscator)..."

# Step 4a: console除去 + minify (terser)
npx terser public/widget.js \
  --compress drop_console=true,drop_debugger=true \
  --mangle \
  --output public/widget.terser.js

# Step 4b: 難読化 (javascript-obfuscator)
npx javascript-obfuscator public/widget.terser.js \
  --output public/widget.min.js \
  --compact true \
  --control-flow-flattening true \
  --control-flow-flattening-threshold 0.5 \
  --dead-code-injection true \
  --dead-code-injection-threshold 0.2 \
  --string-array true \
  --string-array-encoding rc4 \
  --self-defending true \
  --disable-console-output true

# cleanup
rm -f public/widget.terser.js

echo "    → 難読化完了: public/widget.min.js ($(wc -c < public/widget.min.js) bytes)"

# ---------------------------------------------------------------------------
# 5. gzip 事前圧縮
# ---------------------------------------------------------------------------

echo "[5/5] gzip 事前圧縮..."
gzip -9 -k -f "${MINIFIED}"
echo "    gzip: ${MINIFIED}.gz"

# ---------------------------------------------------------------------------
# latest シンボリックリンク（or コピー）
# ---------------------------------------------------------------------------

LATEST="${DIST}/widget.latest.min.js"
if ln -sf "widget.v${VERSION}.min.js" "${LATEST}" 2>/dev/null; then
  echo "[+] シンボリックリンク作成: ${LATEST} → widget.v${VERSION}.min.js"
else
  cp "${MINIFIED}" "${LATEST}"
  echo "[+] コピー（symlink不可）: ${LATEST}"
fi

# ---------------------------------------------------------------------------
# 完了サマリー
# ---------------------------------------------------------------------------

echo ""
echo "=== ビルド完了 ==="
echo ""
ls -lh "${DIST}/" | grep "widget"
echo ""

# ファイルサイズ比較
ORIG_SIZE=$(wc -c < "${SRC}" | tr -d ' ')
MIN_SIZE=$(wc -c < "${MINIFIED}" | tr -d ' ')
GZ_SIZE=$(wc -c < "${MINIFIED}.gz" | tr -d ' ')
OBF_SIZE=$(wc -c < "public/widget.min.js" | tr -d ' ')
RATIO=$((100 - GZ_SIZE * 100 / ORIG_SIZE))

echo "圧縮率サマリー:"
echo "  オリジナル:     ${ORIG_SIZE} bytes"
echo "  Minified:       ${MIN_SIZE} bytes ($(( MIN_SIZE * 100 / ORIG_SIZE ))% of original)"
echo "  gzip:           ${GZ_SIZE} bytes (${RATIO}% 削減)"
echo "  難読化:         ${OBF_SIZE} bytes → public/widget.min.js"
echo ""
echo "CDN配信 URL 例:"
echo "  開発: http://65.108.159.161:3100/widget.js"
echo "  本番: https://cdn.rajiuce.com/widget.v${VERSION}.min.js"
echo ""
echo "Nginx Cache-Control ヘッダー設定例:"
echo "  widget.min.js → Cache-Control: public, max-age=3600, immutable"
echo "  widget.latest → Cache-Control: public, max-age=300"
