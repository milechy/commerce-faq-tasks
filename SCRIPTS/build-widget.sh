#!/usr/bin/env bash
# =============================================================================
# build-widget.sh — Widget ビルド・最適化・バージョニング (Phase33 Stream D)
#
# 使い方:
#   bash SCRIPTS/build-widget.sh [VERSION]
#
# 引数:
#   VERSION  バージョン文字列（省略時: "1.0.0"）
#
# 出力 (dist/widget/):
#   widget.js                 — オリジナルをそのままコピー（開発用）
#   widget.v<VERSION>.js      — バージョン付きコピー
#   widget.v<VERSION>.min.js  — Minify版
#   widget.v<VERSION>.min.js.gz — gzip事前圧縮版
#   widget.latest.min.js      — 最新版へのシンボリックリンク（or コピー）
#
# 依存ツール（いずれかが必要）:
#   - terser (推奨): pnpm add -D terser
#   - uglify-js (代替): pnpm add -D uglify-js
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
echo "[1/4] コピー完了: ${DIST}/widget.js"

# ---------------------------------------------------------------------------
# 2. バージョン付きコピー
# ---------------------------------------------------------------------------

cp "${SRC}" "${DIST}/widget.v${VERSION}.js"
echo "[2/4] バージョン付きコピー: ${DIST}/widget.v${VERSION}.js"

# ---------------------------------------------------------------------------
# 3. Minify（terser → uglify-js の順でフォールバック）
# ---------------------------------------------------------------------------

MINIFIED="${DIST}/widget.v${VERSION}.min.js"

# バナーコメント（CDNキャッシュに含めるバージョン情報）
BANNER="/* RAJIUCE FAQ Widget v${VERSION} | (c) $(date +%Y) RAJIUCE | MIT */"

if command -v terser &>/dev/null; then
  echo "[3/4] Minify (terser)..."
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
  echo "[3/4] Minify (uglify-js)..."
  uglifyjs "${SRC}" \
    --compress \
    --mangle \
    --output "${MINIFIED}" \
    --preamble "${BANNER}"
  echo "    → uglify-js 完了"

else
  echo "[3/4] WARNING: terser も uglify-js も見つかりません。コピーのみ実行します。"
  echo "      インストール: pnpm add -D terser"
  cp "${SRC}" "${MINIFIED}"
fi

echo "    Minified: ${MINIFIED}"

# ---------------------------------------------------------------------------
# 4. gzip 事前圧縮
# ---------------------------------------------------------------------------

echo "[4/4] gzip 事前圧縮..."
gzip -9 -k -f "${MINIFIED}"
echo "    gzip: ${MINIFIED}.gz"

# ---------------------------------------------------------------------------
# 5. latest シンボリックリンク（or コピー）
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
RATIO=$((100 - GZ_SIZE * 100 / ORIG_SIZE))

echo "圧縮率サマリー:"
echo "  オリジナル:     ${ORIG_SIZE} bytes"
echo "  Minified:       ${MIN_SIZE} bytes ($(( MIN_SIZE * 100 / ORIG_SIZE ))% of original)"
echo "  gzip:           ${GZ_SIZE} bytes (${RATIO}% 削減)"
echo ""
echo "CDN配信 URL 例:"
echo "  開発: http://65.108.159.161:3100/widget.js"
echo "  本番: https://cdn.rajiuce.com/widget.v${VERSION}.min.js"
echo ""
echo "Nginx Cache-Control ヘッダー設定例:"
echo "  widget.min.js → Cache-Control: public, max-age=3600, immutable"
echo "  widget.latest → Cache-Control: public, max-age=300"
