#!/bin/bash
# SCRIPTS/post-deploy-widget-smoke.sh
#
# デプロイ直後に、本番のウィジェットで実際に会話が成立するかをブラウザで確認する。
# SCRIPTS/post-deploy-smoke.sh(HTTPレベル)では検知できない層を埋める。
#
# 背景: 2026-08-29、PR #1039 が widget.js の `var _abExposureSent = false;` の宣言を
# 消し、recordAbExposure() の ReferenceError で sendMessage() が停止した。全テナントの
# チャットが「送信しても何も起きない」状態になったが、widget.js は HTTP 200 を返し
# Content-Type も javascript だったため HTTPスモークは全て緑だった。壊れていたのは
# 実行結果だけで、それを見るにはブラウザで動かすしかない。
#
# 使用: bash SCRIPTS/post-deploy-widget-smoke.sh [API_URL]
# 終了コード: 0=成功 / 1=失敗(本番が壊れている疑い) / 0=ブラウザ未導入でスキップ
#
# ブラウザが起動できない環境ではスキップする(終了コード0)。デプロイ機に Chrome が
# 無いことを理由にデプロイ全体を止めても、本番の異常とは無関係なノイズにしかならない。
# ただし「検証していない」ことは必ず目立つ形で表示する。

set -uo pipefail

API_URL="${1:-https://api.r2c.biz}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$REPO_ROOT"

echo "── ウィジェット会話スモーク (ブラウザ) ─────────────────────────────"
echo "   対象: $API_URL/carnation-demo/index.html"

# ブラウザが起動できるかを先に判定する。playwright 自体が無い / Chrome が無い場合に
# テスト失敗と区別がつかないまま赤くなるのを避ける。
if ! pnpm exec playwright --version >/dev/null 2>&1; then
  echo "   ⏭️  SKIP: playwright が見つからない（pnpm install 未実行の環境）"
  echo "      本番のチャットが動作するかは未検証のまま。手元で確認すること:"
  echo "      pnpm smoke:widget"
  exit 0
fi

if ! node -e "
  const { chromium } = require('@playwright/test');
  chromium.launch({ channel: 'chrome' }).then(b => b.close()).then(
    () => process.exit(0),
    () => process.exit(1),
  );
" >/dev/null 2>&1; then
  echo "   ⏭️  SKIP: Chrome を起動できない（デプロイ機に Chrome が無い等）"
  echo "      本番のチャットが動作するかは未検証のまま。手元で確認すること:"
  echo "      pnpm smoke:widget"
  exit 0
fi

# 対象を明示する。tests/smoke には admin-ui 用のスモークもあり、そちらは
# Cloudflare Pages 配信で VPS デプロイとは無関係なため、ここでは走らせない。
if SMOKE_API_URL="$API_URL" pnpm exec playwright test --config=playwright.smoke.config.ts \
     tests/smoke/widgetChatSmoke.spec.ts; then
  echo "   ✅ 本番のウィジェットで会話が成立した"
  exit 0
fi

echo ""
echo "   ❌ 本番のウィジェットで会話が成立しない"
echo "      デプロイは完了しているが、訪問者はチャットを使えない状態の疑いがある。"
echo "      ロールバック判断が必要。まず playwright-report / test-results の"
echo "      スクリーンショットと trace を見ること。JS例外が出ていれば widget.js が原因。"
exit 1
