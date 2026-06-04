#!/usr/bin/env bash
# SCRIPTS/24h-preflight.sh
# 24h 自走起動前 worktree/branch 安全化ガード (Asana 1214955323124286)
#
# 実行タイミング: 24h-autonomous.md Phase 0 の先頭で必ず実行
# 正常: exit 0 + Slack 完了通知
# 異常: exit 1 + Slack alert → 24h 自走起動中止
#
# 実施内容:
#   Step 1: git worktree prune --expire=now (破損 worktree 除去)
#   Step 2: git fetch origin --prune (remote 削除済みブランチを同期)
#   Step 3: stale branch 検出 ([remote: gone] 上限超過で exit 1)
#   Step 4: merged branch 削除 (main / 保護ブランチ / 現役 worktree 除外)
#   Step 5: 結果を Slack #r2c に通知
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NOTIFY="$SCRIPT_DIR/notify-slack.sh"

# 保護ブランチ前方一致: 削除・stale 警告から除外
PROTECTED_PREFIXES=(
  "main"
  "feature/phase69-2-followup"
)

# stale branch 上限 (超過 → exit 1 で起動中止)
STALE_LIMIT=5

cd "$REPO_ROOT"

# ── ログ / fail ヘルパ ─────────────────────────────────────────────────────
log()  { printf '[24h-preflight] %s\n' "$*" >&2; }

fail() {
  local msg="$1"
  log "FAIL: $msg"
  "$NOTIFY" "🛑 24h-preflight FAIL: $msg" --color error 2>/dev/null \
    || printf '[24h-preflight] SLACK FALLBACK: %s\n' "$msg" >&2
  exit 1
}

# ── 保護ブランチ判定 ───────────────────────────────────────────────────────
is_protected() {
  local branch="$1"
  for prefix in "${PROTECTED_PREFIXES[@]}"; do
    if [[ "$branch" == "$prefix" \
       || "$branch" == "${prefix}/"* \
       || "$branch" == "${prefix}-"* ]]; then
      return 0
    fi
  done
  return 1
}

# ─── Step 1: worktree prune ───────────────────────────────────────────────
log "Step 1: git worktree prune --expire=now"
git worktree prune --expire=now \
  || fail "git worktree prune --expire=now に失敗"

# prune 後も path が存在しない worktree エントリが残っていれば破損と判定
BROKEN_WTS=()
while IFS= read -r line; do
  if [[ "$line" =~ ^worktree[[:space:]] ]]; then
    wt_path="${line#worktree }"
    if [[ ! -d "$wt_path" ]]; then
      BROKEN_WTS+=("$wt_path")
    fi
  fi
done < <(git worktree list --porcelain)

if [[ ${#BROKEN_WTS[@]} -gt 0 ]]; then
  fail "破損 worktree を検出 (prune 後も残存): ${BROKEN_WTS[*]}"
fi
log "worktree prune OK (broken: 0)"

# ─── Step 2: fetch origin --prune ─────────────────────────────────────────
log "Step 2: git fetch origin --prune"
git fetch origin --prune \
  || fail "git fetch origin --prune に失敗 (ネットワーク確認)"
log "fetch OK"

# ─── Step 3: stale branch 検出 ────────────────────────────────────────────
log "Step 3: stale branch 検出 [remote: gone]"
STALE_BRANCHES=()
while IFS= read -r line; do
  branch=$(printf '%s' "$line" | sed 's/^[* ]*//' | awk '{print $1}')
  [[ -n "$branch" ]] && STALE_BRANCHES+=("$branch")
done < <(git branch -vv | grep '\[.*: gone\]' || true)

STALE_COUNT=${#STALE_BRANCHES[@]}
STALE_STR="${STALE_BRANCHES[*]:-なし}"
log "stale branches: ${STALE_COUNT}件 — ${STALE_STR}"

if (( STALE_COUNT > STALE_LIMIT )); then
  fail "stale branch 上限超過 (${STALE_COUNT}件 > 上限 ${STALE_LIMIT}件)。手動確認後に再起動してください: ${STALE_STR}"
fi

# ─── Step 4: merged branch 削除 ───────────────────────────────────────────
log "Step 4: merged branch 削除 (main / 保護 / 現役 worktree 除外)"

# 現役 worktree でチェックアウト中のブランチを収集
WORKTREE_BRANCHES=()
while IFS= read -r line; do
  if [[ "$line" =~ ^branch[[:space:]] ]]; then
    wt_branch="${line#branch refs/heads/}"
    [[ -n "$wt_branch" ]] && WORKTREE_BRANCHES+=("$wt_branch")
  fi
done < <(git worktree list --porcelain)

is_active_worktree() {
  local branch="$1"
  for wt in "${WORKTREE_BRANCHES[@]+"${WORKTREE_BRANCHES[@]}"}"; do
    [[ "$branch" == "$wt" ]] && return 0
  done
  return 1
}

DELETED=()
SKIPPED=()

while IFS= read -r raw; do
  # strip leading '*' (current), '+' (other worktree), spaces
  branch=$(printf '%s' "$raw" | sed 's/^[*+ ]*//')
  [[ -z "$branch" || "$branch" == "main" ]] && continue

  if is_protected "$branch"; then
    log "  SKIP (protected): $branch"
    SKIPPED+=("${branch}:protected")
  elif is_active_worktree "$branch"; then
    log "  SKIP (worktree): $branch"
    SKIPPED+=("${branch}:worktree")
  elif git branch -d "$branch" 2>/dev/null; then
    log "  DELETED: $branch"
    DELETED+=("$branch")
  else
    log "  SKIP (not-fully-merged): $branch"
    SKIPPED+=("${branch}:not-fully-merged")
  fi
done < <(git branch --merged main | grep -v '^\*' || true)

# ─── Step 5: Slack 通知 ───────────────────────────────────────────────────
log "Step 5: Slack 通知"

DELETED_STR="${DELETED[*]:-なし}"
SKIPPED_STR="${SKIPPED[*]:-なし}"

MSG="🔍 24h-preflight 完了 ($(date '+%Y-%m-%d %H:%M'))
• stale branches: ${STALE_COUNT}件 — ${STALE_STR}
• 削除済み merged: ${DELETED_STR}
• スキップ: ${SKIPPED_STR}
✅ worktree & branch 安全確認済み — 24h 自走起動可能"

"$NOTIFY" "$MSG" --color success 2>/dev/null \
  || log "WARN: Slack 通知失敗 (preflight 自体は正常完了)"

log "完了 ✅ exit 0"
exit 0
