#!/usr/bin/env bash
set -euo pipefail

# Phase28: VPS deploy script
# Usage: bash SCRIPTS/deploy-vps.sh [user@host]
#
# NOTE: As of 2026-04-17, Admin UI is served via Cloudflare Pages.
# This script deploys API + Widget + avatar-agent only to VPS.
# Admin UI deployment is handled automatically by Cloudflare Pages
# when changes are pushed to the main branch.
#
# Prerequisites on VPS:
#   - Node.js 20.x installed
#   - corepack enable && corepack prepare pnpm@9.15.9 --activate
#   - npm install -g pm2
#   - PostgreSQL + Elasticsearch running

VPS="${1:-root@65.108.159.161}"
REMOTE_DIR="/opt/rajiuce"

# CWD guard: must be run from project root
if [[ ! -f package.json ]] || [[ ! -f ecosystem.config.cjs ]]; then
  echo "❌ ERROR: deploy-vps.sh must be run from the project root directory"
  echo "  Current directory: $(pwd)"
  echo "  Expected: package.json and ecosystem.config.cjs in CWD"
  exit 1
fi

# Branch guard: this script deploys the LOCAL working tree (git build → rsync),
# not origin/main. Deploying from a non-main branch silently puts production
# ahead of main — anyone who later deploys from main will roll production back
# without any error (past incident: fix/round-double-precision-analytics-summary
# was deployed while main still lacked the fix, until the PR was merged).
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
if [[ "${CURRENT_BRANCH}" != "main" ]] && [[ "${DEPLOY_ALLOW_NON_MAIN:-0}" != "1" ]]; then
  echo "❌ ERROR: current branch is '${CURRENT_BRANCH}', not 'main'"
  echo "  This script deploys whatever is checked out locally, not origin/main."
  echo "  Deploying from a feature branch puts production ahead of main until"
  echo "  that branch is merged — the next main-based deploy will silently roll it back."
  echo ""
  echo "  Fix: git checkout main && git pull --ff-only origin main, then re-run."
  echo "  Intentional hotfix verification before merge? Re-run with:"
  echo "    DEPLOY_ALLOW_NON_MAIN=1 bash SCRIPTS/deploy-vps.sh"
  exit 1
fi
if [[ "${CURRENT_BRANCH}" != "main" ]]; then
  echo "⚠️  WARNING: deploying from non-main branch '${CURRENT_BRANCH}' (DEPLOY_ALLOW_NON_MAIN=1)"
  echo "  Remember to merge this branch to main promptly to avoid prod/main desync."
fi

# Pre-deploy: Environment Check (warning-only, does not block deploy)
echo "=== Pre-deploy: Environment Check ==="
bash SCRIPTS/env-check.sh 2>&1 || true
echo ""

echo "=== Phase28: Deploy to ${VPS}:${REMOTE_DIR} ==="

# === VPS Integrity Guards ===
echo "=== VPS Integrity Guards ==="

# Guard 4-B: Abort if VPS has modified tracked files (VPS should be a clean deploy target)
# NOTE: Only checks modified tracked files (grep -v '^??'). Untracked files (rsync-transferred
# local-only dirs like docs/investigation/) are intentionally excluded to prevent false positives.
#
# Asana 1217807146778609: この判定は git が使えることが前提。VPS の /opt/rajiuce/.git は
# 2026-07-30 と 2026-08-01 の2回、中核(objects/HEAD/config/refs)だけが消えて壊れている。
# 壊れていると git status が失敗するが、旧実装ではパイプの最後の tr が成功するため
# UNCOMMITTED="0" となり、「✅ clean」という嘘の緑を毎回出していた(ガードが無いより悪い:
# 「確認した」という誤った安心を与える)。そのため fail closed にする — git が使えないときは
# 緑を出さず、何が検証できていないかを明示する。
# 削除される差分の実質的な検知は [2/5] 直前の rsync --dry-run が担う(git に依存しない)。
if ssh "${VPS}" "cd ${REMOTE_DIR} && git rev-parse --git-dir" >/dev/null 2>&1; then
    UNCOMMITTED=$(ssh "${VPS}" "cd ${REMOTE_DIR} && git status --porcelain | grep -v '^\?\?' | wc -l | tr -d ' '")
    if [ "${UNCOMMITTED}" -gt 0 ]; then
        echo "⚠️  WARNING: Modified tracked files on VPS (${UNCOMMITTED} files):"
        ssh "${VPS}" "cd ${REMOTE_DIR} && git status --short" || true
        echo ""
        echo "🛑 Aborting deploy. VPS has local modifications that may be overwritten."
        echo "   To clean up VPS and retry:"
        echo "     ssh ${VPS} \"cd ${REMOTE_DIR} && git stash push -u -m 'backup-$(date +%Y%m%d)-before-reset' && git fetch origin && git reset --hard origin/main\""
        exit 1
    fi
    echo "  ✅ Guard 4-B: VPS git status clean (tracked files)"
else
    echo "  ⚠️  Guard 4-B: SKIPPED — ${REMOTE_DIR} is not a usable git repository on the VPS"
    echo "      VPS 側の手動変更は検知できていません(緑ではありません)。Asana 1217807146778609"
    echo "      削除される差分は [2/5] 直前の rsync --dry-run プレビューで確認してください。"
fi

# Pre-deploy VPS cleanup: remove known local-only dirs that rsync may have transferred previously
# Protects: avatar-agent/venv/ (excluded by rsync), models/ (not transferred)
ssh "${VPS}" "rm -rf ${REMOTE_DIR}/docs/investigation/ ${REMOTE_DIR}/.wolf/ 2>/dev/null; true"
echo "  ✅ Pre-deploy cleanup: removed rsync-only untracked dirs from VPS"

# Guard 4-A: Detect recent npm usage (this project uses pnpm — npm install corrupts node_modules)
CLEAN_REBUILD=0
RECENT_NPM_LOG=$(ssh "${VPS}" "ls -t /root/.npm/_logs/*.log 2>/dev/null | head -1 || true" || echo "")
if [ -n "${RECENT_NPM_LOG}" ]; then
    LOG_AGE=$(ssh "${VPS}" "echo \$(( (\$(date +%s) - \$(stat -c %Y '${RECENT_NPM_LOG}' 2>/dev/null || echo 0)) / 86400 ))" || echo "99")
    if [ "${LOG_AGE}" -lt 7 ]; then
        echo "⚠️  Guard 4-A: Recent npm usage detected (${LOG_AGE}d ago: ${RECENT_NPM_LOG})"
        echo "⚠️  Direct npm install may have corrupted pnpm node_modules. Forcing clean rebuild."
        CLEAN_REBUILD=1
    fi
fi
[ "${CLEAN_REBUILD}" = "0" ] && echo "  ✅ Guard 4-A: No recent npm usage detected"

# Guard 4-C: Detect broken pnpm node_modules (pnpm uses symlinks; npm install creates real dirs)
# test -L returns true for symlinks (pnpm), false for real directories (npm-created)
for pkg in adm-zip express pdf-parse; do
    IS_SYMLINK=$(ssh "${VPS}" "test -L ${REMOTE_DIR}/node_modules/${pkg} && echo yes || echo no" || echo "no")
    if [ "${IS_SYMLINK}" = "no" ] && ssh "${VPS}" "test -e ${REMOTE_DIR}/node_modules/${pkg}" 2>/dev/null; then
        echo "⚠️  Guard 4-C: ${pkg} is a real directory, not a pnpm symlink. Forcing clean rebuild."
        CLEAN_REBUILD=1
    fi
done
[ "${CLEAN_REBUILD}" = "0" ] && echo "  ✅ Guard 4-C: pnpm symlinks intact"

if [ "${CLEAN_REBUILD}" = "1" ]; then
    echo "  🔧 Removing node_modules on VPS for clean rebuild..."
    ssh "${VPS}" "rm -rf ${REMOTE_DIR}/node_modules"
fi

# Guard 4-D: 課金スキーマの必須列が本番DBに揃っているか(2026-08-25 収益監査で判明)。
# 検出器(src/api/admin/analytics/schemaHealth.ts の fetchSchemaHealth)は
# アプリ起動時・billingHealthMonitor(1時間毎)でも評価するが、いずれも
# 「動いた後に気づく」経路であり、デプロイそのものは止めない。ここでは
# 新しいコードを配る前に、そのコードが要求する列が実際に存在することを
# 確認し、欠落していればデプロイを中断する(migration の自動適用はしない
# — CLAUDE.md 禁止8。人間が確認して適用する)。
#
# ★列挙はここに直書きする(TSを実行できないbashのため)★
# src/api/admin/analytics/schemaHealth.ts の REQUIRED_COLUMNS のうち billing
# 関連テーブルの部分集合と同期させること。同じ部分集合は
# src/lib/billing/billingSqlIntegration.test.ts の BILLING_TABLES にもあり、
# そちらは CI(Gate 4)で実 Postgres に対して機械的に検証される。
# 3箇所目を増やさない — 列を足すときはこの3箇所を同時に直す。
DB_URL=$(ssh "${VPS}" "grep -m1 '^DATABASE_URL=' ${REMOTE_DIR}/.env 2>/dev/null | cut -d= -f2-" || echo "")
if [ -z "${DB_URL}" ]; then
    echo "  ⚠️  Guard 4-D: SKIPPED — VPS の .env に DATABASE_URL が見つかりません"
else
    SCHEMA_CHECK_SQL="
WITH required(tbl, col) AS (VALUES
  ('billing_adjustments','adjusted_by'), ('billing_adjustments','amount'),
  ('billing_adjustments','reason'), ('billing_adjustments','tenant_id'),
  ('lemonslice_monthly_charges','amount_jpy'), ('lemonslice_monthly_charges','period_yyyymm'),
  ('lemonslice_monthly_charges','tenant_count'), ('lemonslice_monthly_charges','tenant_id'),
  ('livekit_monthly_charges','amount_jpy'), ('livekit_monthly_charges','period_yyyymm'),
  ('livekit_monthly_charges','tenant_count'), ('livekit_monthly_charges','tenant_id'),
  ('platform_monthly_charges','amount_jpy'), ('platform_monthly_charges','period_yyyymm'),
  ('platform_monthly_charges','tenant_count'), ('platform_monthly_charges','tenant_id'),
  ('stripe_usage_reports','billed_quantity'), ('stripe_usage_reports','idempotency_key'),
  ('stripe_usage_reports','period_yyyymm'), ('stripe_usage_reports','tenant_id'),
  ('stripe_usage_reports','total_cost_cents'), ('stripe_usage_reports','total_requests'),
  ('stripe_webhook_events','claimed_at'), ('stripe_webhook_events','event_id'),
  ('stripe_webhook_events','event_type'),
  ('usage_logs','anam_session_seconds'), ('usage_logs','avatar_credits'),
  ('usage_logs','avatar_session_ms'), ('usage_logs','billable'),
  ('usage_logs','cost_llm_cents'), ('usage_logs','cost_total_cents'),
  ('usage_logs','feature_used'), ('usage_logs','input_tokens'),
  ('usage_logs','model'), ('usage_logs','output_tokens'),
  ('usage_logs','plan'), ('usage_logs','plan_multiplier'),
  ('usage_logs','request_id'), ('usage_logs','tts_text_bytes')
)
SELECT r.tbl || '.' || r.col
FROM required r
LEFT JOIN information_schema.columns c
  ON c.table_schema = 'public' AND c.table_name = r.tbl AND c.column_name = r.col
WHERE c.column_name IS NULL
ORDER BY 1;
"
    MISSING=$(ssh "${VPS}" "psql \"${DB_URL}\" -tA -c \"${SCHEMA_CHECK_SQL}\"" 2>&1 || echo "QUERY_FAILED")
    if [ "${MISSING}" = "QUERY_FAILED" ]; then
        echo "  ⚠️  Guard 4-D: SKIPPED — 本番DBへのスキーマ確認クエリが失敗しました(接続不可等)"
    elif [ -n "${MISSING}" ]; then
        echo "❌ Guard 4-D: 本番DBに課金スキーマの必須列が欠落しています:"
        echo "${MISSING}" | sed 's/^/    /'
        echo ""
        echo "🛑 Aborting deploy. 新しいコードはこれらの列を前提にしています。"
        echo "   該当する migration_*.sql を人間が確認のうえ本番へ適用してから再実行してください"
        echo "   (migration の自動実行は禁止。一覧: SCRIPTS/ci-billing-schema.sh の FILES 配列)。"
        exit 1
    else
        echo "  ✅ Guard 4-D: 課金スキーマの必須列は揃っています"
    fi
fi
echo ""

echo "[0/5] VPSファイル所有者正常化..."
# rsync -a がMac側のUID(501)を保持するため、pnpmがUID 1001 sandboxでvite buildを実行し
# 環境変数が継承されない問題を防ぐ。rsync前にVPS側をroot:rootに正規化する。
ssh "${VPS}" "chown -R root:root ${REMOTE_DIR} 2>/dev/null || true"
echo "  ✅ VPSファイル所有者: root:root に正規化完了"

echo "[1/5] Building API server locally (VPS OOM対策: ローカルtsc → dist/をrsync転送)..."
pnpm build
echo "  ✅ Local build complete: dist/ ready"

echo "[2/5] Syncing repository to VPS..."
# NOTE: --exclude '.env*' prevents rsync --delete from wiping VPS env files.
# VPS holds the authoritative .env with production secrets.
#
# 除外リストは配列に切り出してある。下の --dry-run プレビューと本番転送で同一の
# ルールを使うため(片方だけ書き換えると、プレビューが嘘になる)。
RSYNC_EXCLUDES=(
  --exclude 'node_modules/'
  --exclude '.pnpm-store/'
  --exclude 'admin-ui/node_modules/'
  --exclude 'admin-ui/dist/'
  --exclude '.env'
  --exclude '.env.*'
  --exclude '.git/'
  --exclude 'logs/'
  --exclude '*.log'
  --exclude '*.zip'
  --exclude '_bundle/'
  --exclude '.DS_Store'
  --exclude '.vscode/'
  --exclude '.devcontainer/'
  --exclude '__pycache__/'
  --exclude 'avatar-agent/venv/'
  --exclude 'docs/investigation/'
  --exclude '.wolf/'
  --exclude 'slack-listener/'
  --exclude 'coverage/'
  --exclude '.claude/agent-memory/'
  --exclude '.claude/worktrees/'
)

# Guard 4-B の代替(git非依存): --delete で VPS から消えるものを事前に列挙する。
# Guard 4-B が git 破損で機能しない状況でも、「VPS 側にしか無いファイルが黙って消える」
# という最も実害のある事象だけは確実に可視化できる。
# 想定を超える件数(=除外設定ミス等)のときは中断する。意図的なら DEPLOY_ALLOW_DELETIONS=1。
echo "  Previewing deletions (rsync --dry-run)..."
DELETION_LIST=$(rsync -az --delete --dry-run --itemize-changes "${RSYNC_EXCLUDES[@]}" \
  ./ "${VPS}:${REMOTE_DIR}/" 2>/dev/null | grep '^\*deleting' || true)
DELETION_COUNT=$(printf '%s' "${DELETION_LIST}" | grep -c . || true)

if [ "${DELETION_COUNT}" -gt 0 ]; then
    echo "  ⚠️  ${DELETION_COUNT} path(s) on the VPS will be DELETED by this deploy:"
    printf '%s\n' "${DELETION_LIST}" | sed 's/^/      /'
    if [ "${DELETION_COUNT}" -gt "${DEPLOY_MAX_DELETIONS:-30}" ] && [ "${DEPLOY_ALLOW_DELETIONS:-0}" != "1" ]; then
        echo ""
        echo "🛑 Aborting: deletion count exceeds ${DEPLOY_MAX_DELETIONS:-30}."
        echo "   想定外の量です。除外設定の誤りか、VPS 側に大量の独自ファイルがある可能性があります。"
        echo "   内容を確認のうえ意図通りなら: DEPLOY_ALLOW_DELETIONS=1 bash SCRIPTS/deploy-vps.sh"
        exit 1
    fi
else
    echo "  ✅ No files will be deleted from the VPS"
fi

rsync -avz --delete "${RSYNC_EXCLUDES[@]}" ./ "${VPS}:${REMOTE_DIR}/"

# rsync後の所有者正規化: Mac側UID(501)がrsync -a で転送されてもroot:rootに上書き
ssh "${VPS}" "chown -R root:root ${REMOTE_DIR} 2>/dev/null || true"
echo "  ✅ rsync後VPSファイル所有者: root:root に正規化完了"

echo "[3/5] Installing dependencies on VPS..."
ssh "${VPS}" "cd ${REMOTE_DIR} && corepack enable && pnpm install --frozen-lockfile"
echo "  ✅ API build: dist/ transferred via rsync — VPS tsc build skipped (OOM prevention)"

echo "[3.5/5] Updating avatar-agent Python dependencies..."
ssh "${VPS}" "cd ${REMOTE_DIR}/avatar-agent && python3 -m venv venv && source venv/bin/activate && pip install --upgrade pip -q && pip install -r requirements.txt -q"
echo "  ✅ avatar-agent venv updated"

echo "[4/5] Starting services with PM2..."
ssh "${VPS}" "cd ${REMOTE_DIR} && pm2 startOrRestart ecosystem.config.cjs --env production --only rajiuce-api,rajiuce-avatar"
ssh "${VPS}" "pm2 save"

echo "[5/5] Reloading Nginx..."
ssh "${VPS}" "nginx -t && systemctl reload nginx && echo ' Nginx reloaded OK' || echo ' Nginx reload FAILED'"

echo "=== Health check ==="
sleep 3  # PM2 起動待ち
ssh "${VPS}" "curl -sf http://localhost:3100/health && echo ' API OK' || echo ' API FAILED'"

echo ""
echo "=== Running post-deploy smoke test ==="
bash SCRIPTS/post-deploy-smoke.sh || echo "⚠️  Some smoke tests failed (non-blocking)"

echo ""
echo "=== Deploy complete ==="
echo "API:      https://api.r2c.biz/health"
echo "Widget:   https://api.r2c.biz/widget.js"
echo "Admin UI: https://admin.r2c.biz/ (Cloudflare Pages — 自動デプロイ済み)"
echo ""
echo "NOTE: VPS .env is preserved by rsync (never overwritten)."
echo "  To update secrets: ssh root@65.108.159.161 'nano /opt/rajiuce/.env'"
echo ""
echo "First time? Run on VPS:"
echo "  pm2 startup"
echo "  pm2 install pm2-logrotate"
