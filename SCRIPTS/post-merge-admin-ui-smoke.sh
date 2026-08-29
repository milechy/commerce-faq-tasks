#!/bin/bash
# SCRIPTS/post-merge-admin-ui-smoke.sh
#
# admin-ui の「デプロイ直後」に相当する検証。admin-ui は Cloudflare Pages 配信で
# main へのマージ = 即本番のため、VPS の deploy-vps.sh を経由せず
# SCRIPTS/post-deploy-widget-smoke.sh が走らない。その穴を post-merge で埋める。
#
# 使用: bash SCRIPTS/post-merge-admin-ui-smoke.sh [ADMIN_URL]
# 終了コード: 0=成功 または スキップ / 1=失敗(本番のadmin-uiが起動していない疑い)
#
# Cloudflare Pages のビルド完了を待つ必要がある。マージ直後は旧ビルドが配信されて
# いるため、そのまま検証しても「直前の状態が無事」を確認するだけになる。
# index.html が参照するアセット名(vite の content hash 付き)が変わったことを
# 公開の完了と見なして待つ。

set -uo pipefail

ADMIN_URL="${1:-https://admin.r2c.biz}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WAIT_TIMEOUT_SEC="${ADMIN_UI_PUBLISH_TIMEOUT_SEC:-300}"
POLL_INTERVAL_SEC=15

cd "$REPO_ROOT"

echo "── admin-ui 起動スモーク (ブラウザ) ────────────────────────────────"
echo "   対象: $ADMIN_URL"

current_asset() {
  curl -s --max-time 15 "$ADMIN_URL/" 2>/dev/null \
    | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' \
    | head -1
}

# このマージが admin-ui を触っていなければ、Cloudflare Pages の再ビルドは
# 起きない(または成果物が同一)。待っても無駄なので即実行する。
touched_admin_ui=0
if git rev-parse HEAD^ >/dev/null 2>&1; then
  if git diff --name-only HEAD^ HEAD 2>/dev/null | grep -qE '^admin-ui/'; then
    touched_admin_ui=1
  fi
else
  # 親コミットが取れない(shallow clone等)場合は判定できないので待つ側に倒す
  touched_admin_ui=1
fi

if [ "$touched_admin_ui" -eq 1 ]; then
  before="$(current_asset)"
  echo "   admin-ui の変更を検出。Cloudflare Pages の公開を待つ (最大 ${WAIT_TIMEOUT_SEC}秒)"
  echo "   マージ前のアセット: ${before:-取得できず}"

  waited=0
  while [ "$waited" -lt "$WAIT_TIMEOUT_SEC" ]; do
    sleep "$POLL_INTERVAL_SEC"
    waited=$((waited + POLL_INTERVAL_SEC))
    after="$(current_asset)"
    if [ -n "$after" ] && [ "$after" != "$before" ]; then
      echo "   ✅ 新しいビルドが公開された (${waited}秒): ${after}"
      break
    fi
  done

  if [ "$waited" -ge "$WAIT_TIMEOUT_SEC" ]; then
    # 公開が確認できなくても検証自体は行う。admin-ui の変更がバンドルの
    # content hash を変えない場合(コメントのみ等)もあるため、ここでは失敗にしない。
    echo "   ⚠️  ${WAIT_TIMEOUT_SEC}秒待っても公開を確認できなかった。"
    echo "      旧ビルドを検証している可能性がある。結果の解釈に注意すること。"
  fi
else
  echo "   admin-ui に変更なし。公開待ちをスキップして現在の本番を検証する"
fi

if ! pnpm exec playwright --version >/dev/null 2>&1; then
  echo "   ⏭️  SKIP: playwright が見つからない"
  exit 0
fi

if SMOKE_ADMIN_URL="$ADMIN_URL" pnpm exec playwright test \
     --config=playwright.smoke.config.ts tests/smoke/adminUiBootSmoke.spec.ts; then
  echo "   ✅ admin-ui が起動している"
  exit 0
fi

echo ""
echo "   ❌ admin-ui が起動していない"
echo "      管理画面が白画面 / JS例外で使えない状態の疑いがある。"
echo "      直近のマージの revert を検討すること。"
exit 1
