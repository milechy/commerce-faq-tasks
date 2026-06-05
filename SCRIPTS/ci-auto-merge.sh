#!/usr/bin/env bash
# ci-auto-merge.sh — Tier B PR を CI green かつ非 Tier S のとき自動マージする (Mergify 非依存・自前)
#
# 背景: Mergify Free は private repo で rule engine が動かず (config-lint のみ)、
#       auto-merge が一度も発火しなかった。本スクリプト + GitHub Actions workflow で
#       自前の auto-merge を実現する。Tier 判定は既存・テスト済の pr-risk-scorer.sh を正典として再利用。
#
# 判定 (全て満たすと merge):
#   1. PR が OPEN / 非 draft / base=main
#   2. high-risk / do-not-merge / needs-review ラベルが付いていない
#   3. pr-risk-scorer.sh の auto_merge_eligible == true (= Tier B)
#   4. 必須チェックが全て SUCCESS (REQUIRED_CHECKS)
#   5. (任意) 夜間フリーズ: AUTO_MERGE_NIGHT_FREEZE=1 のとき 22:00-07:00 JST は merge しない
#
# 使い方:
#   bash SCRIPTS/ci-auto-merge.sh <PR番号>             # 条件を満たせば squash merge
#   bash SCRIPTS/ci-auto-merge.sh <PR番号> --dry-run   # 判定のみ (merge しない)
#   bash SCRIPTS/ci-auto-merge.sh --self-test          # ラベル/チェック判定ロジックの単体確認
#
# 環境変数:
#   REQUIRED_CHECKS           必須チェック名 CSV (default: 下記4つ)
#   AUTO_MERGE_NIGHT_FREEZE   1 で夜間 (22:00-07:00 JST) を停止 (default: 0 = 24/7 merge)
#   GH_TOKEN / GITHUB_TOKEN   gh CLI 認証 (CI では自動)
#
# 依存: gh, jq

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCORER="${SCRIPT_DIR}/pr-risk-scorer.sh"

DEFAULT_REQUIRED='Gate 1 — typecheck + lint + test,security-scan,path-check,Claude PR Review'
BLOCK_LABELS=("high-risk" "do-not-merge" "needs-review")

log() { printf '[ci-auto-merge] %s\n' "$*" >&2; }

# ─── 純粋判定ヘルパー (self-test 対象) ───────────────────────────────────────

# 引数: ラベル(改行区切り) を stdin。BLOCK_LABELS のいずれかがあれば 1(blocked)。
has_block_label() {
  local labels_csv="$1"
  local l
  for l in "${BLOCK_LABELS[@]}"; do
    if printf '%s' "$labels_csv" | tr ',' '\n' | grep -qx "$l"; then
      return 0
    fi
  done
  return 1
}

# 必須チェックが全て SUCCESS か。引数1: statusCheckRollup JSON, 引数2: REQUIRED CSV。
# 0=all green, 1=未達。未達の理由を stderr に出す。
all_required_green() {
  local rollup="$1" required_csv="$2"
  local ok=0 name concl
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    concl="$(printf '%s' "$rollup" | jq -r --arg n "$name" \
      '[.[] | select((.name // .context) == $n)] | last | (.conclusion // .state // "MISSING")')"
    if [[ "$concl" != "SUCCESS" && "$concl" != "success" ]]; then
      log "  check not green: '${name}' = ${concl}"
      ok=1
    fi
  done < <(printf '%s' "$required_csv" | tr ',' '\n')
  return "$ok"
}

# 夜間フリーズ判定。0=merge可, 1=夜間で停止。
night_frozen() {
  [[ "${AUTO_MERGE_NIGHT_FREEZE:-0}" == "1" ]] || return 1
  # JST hour
  local h
  h="$(TZ=Asia/Tokyo date +%H)"
  h=$((10#$h))
  if (( h >= 22 || h < 7 )); then return 0; fi
  return 1
}

# ─── self-test ───────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--self-test" ]]; then
  fail=0
  has_block_label "high-risk,foo" && echo "PASS block: high-risk 検出" || { echo "FAIL block high-risk"; fail=1; }
  has_block_label "needs-review" && echo "PASS block: needs-review 検出" || { echo "FAIL block needs-review"; fail=1; }
  if has_block_label "tier-b,docs"; then echo "FAIL: 無害ラベルを blocked 判定"; fail=1; else echo "PASS block: 無害ラベルは通す"; fi
  ROLLUP_GREEN='[{"name":"Gate 1 — typecheck + lint + test","conclusion":"SUCCESS"},{"name":"security-scan","conclusion":"SUCCESS"},{"name":"path-check","conclusion":"SUCCESS"},{"name":"Claude PR Review","conclusion":"SUCCESS"}]'
  ROLLUP_RED='[{"name":"Gate 1 — typecheck + lint + test","conclusion":"FAILURE"},{"name":"security-scan","conclusion":"SUCCESS"},{"name":"path-check","conclusion":"SUCCESS"},{"name":"Claude PR Review","conclusion":"SUCCESS"}]'
  ROLLUP_MISSING='[{"name":"security-scan","conclusion":"SUCCESS"}]'
  if all_required_green "$ROLLUP_GREEN" "$DEFAULT_REQUIRED" 2>/dev/null; then echo "PASS green: 全 green 検出"; else echo "FAIL green all"; fail=1; fi
  if all_required_green "$ROLLUP_RED" "$DEFAULT_REQUIRED" 2>/dev/null; then echo "FAIL: red を green 判定"; fail=1; else echo "PASS green: red を検出"; fi
  if all_required_green "$ROLLUP_MISSING" "$DEFAULT_REQUIRED" 2>/dev/null; then echo "FAIL: 欠落 check を green 判定"; fail=1; else echo "PASS green: 欠落 check を検出"; fi
  echo "---"; [[ "$fail" == 0 ]] && { echo "✅ self-test PASS"; exit 0; } || { echo "❌ self-test FAIL"; exit 1; }
fi

# ─── 引数 ────────────────────────────────────────────────────────────────────
PR_NUMBER="${1:-}"
DRY_RUN=0
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=1
[[ -z "$PR_NUMBER" ]] && { log "PR番号を指定してください"; exit 2; }
REQUIRED_CSV="${REQUIRED_CHECKS:-$DEFAULT_REQUIRED}"

for cmd in gh jq; do command -v "$cmd" >/dev/null 2>&1 || { log "missing: $cmd"; exit 2; }; done

# ─── PR メタ取得 ─────────────────────────────────────────────────────────────
META="$(gh pr view "$PR_NUMBER" \
  --json number,state,isDraft,baseRefName,headRefName,labels,statusCheckRollup,mergeStateStatus,title \
  2>/dev/null)" || { log "PR #$PR_NUMBER 取得失敗"; exit 2; }

STATE="$(jq -r '.state' <<<"$META")"
DRAFT="$(jq -r '.isDraft' <<<"$META")"
BASE="$(jq -r '.baseRefName' <<<"$META")"
LABELS="$(jq -r '[.labels[].name] | join(",")' <<<"$META")"
ROLLUP="$(jq -c '.statusCheckRollup' <<<"$META")"
TITLE="$(jq -r '.title' <<<"$META")"
MERGE_STATE="$(jq -r '.mergeStateStatus' <<<"$META")"
HEAD_REF="$(jq -r '.headRefName' <<<"$META")"

decline() { log "SKIP #$PR_NUMBER ($1): $TITLE"; exit 0; }

[[ "$STATE" == "OPEN" ]]   || decline "state=$STATE"
[[ "$DRAFT" == "false" ]]  || decline "draft"
[[ "$BASE" == "main" ]]    || decline "base=$BASE"
has_block_label "$LABELS"  && decline "block-label ($LABELS)"
night_frozen               && decline "night-freeze (22:00-07:00 JST)"

# Tier 判定: Tier S のみ human merge required。Tier A/B は全て auto-merge 対象。
# auto/s-* = Tier S → human merge required (merge しない)
# auto/a-* = Tier A loop PR → auto-merge eligible (scorer スキップ)
# auto/b-* = Tier B loop PR → auto-merge eligible (scorer スキップ)
# feature/* 等 (手動PR) → scorer で risk=high なら Tier S 相当として decline
[[ "$HEAD_REF" =~ ^auto/s- ]] && decline "Tier S — human merge required (branch: $HEAD_REF)"
if [[ "$HEAD_REF" =~ ^auto/[ab]- ]]; then
    log "Tier A/B loop PR — auto-merge eligible (branch: $HEAD_REF)"
else
    PR_RISK="$(bash "$SCORER" "$PR_NUMBER" --json-only 2>/dev/null | jq -r '.risk')" || decline "scorer失敗"
    [[ "$PR_RISK" == "high" ]] && decline "Tier S 相当 (risk=high) — human merge required"
    log "risk=$PR_RISK — Tier A/B 相当、auto-merge eligible"
fi

# 必須チェック全 green
all_required_green "$ROLLUP" "$REQUIRED_CSV" || decline "checks not all green"

# コンフリクトは自動解消しない
[[ "$MERGE_STATE" == "DIRTY" ]] && decline "conflict (mergeStateStatus=DIRTY)"

# ─── merge ───────────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" == "1" ]]; then
  log "DRY-RUN: #$PR_NUMBER は全条件クリア → merge 対象 (mergeState=$MERGE_STATE)"
  exit 0
fi

# BEHIND (branch protection strict:true で base に遅れている) は merge できないので、
# branch を base で更新する。更新で CI が再実行されるため、本サイクルでは merge せず
# 次サイクル (check_suite 完了 or 30分 sweep) に委ねる。strict:false なら BEHIND にならず直 merge。
# 24h-mode-on.sh が strict:true を再設定するため、この自己解消は恒久的な堅牢性として必要。
if [[ "$MERGE_STATE" == "BEHIND" ]]; then
  log "BEHIND: #$PR_NUMBER を base で更新 (update-branch)。merge は次サイクルで実行。"
  gh pr update-branch "$PR_NUMBER" 2>&1 | sed 's/^/[ci-auto-merge]   /' >&2 || \
    log "  update-branch 失敗 (権限/競合の可能性) — 次サイクルで再試行"
  exit 0
fi

log "MERGE: #$PR_NUMBER (Tier B / 全 green / mergeState=$MERGE_STATE) を squash merge します"
gh pr merge "$PR_NUMBER" --squash --delete-branch 2>&1 | sed 's/^/[ci-auto-merge]   /' >&2
log "✅ #$PR_NUMBER merged"
