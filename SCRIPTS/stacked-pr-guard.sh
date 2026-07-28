#!/usr/bin/env bash
# stacked-pr-guard.sh — スタックPR(base≠main)のうち、親ブランチが既にmainへ
# マージ済みのものを検出し、needs-reviewラベル + 警告コメントで人間に気付かせる。
# (GID 1216945618304983)
#
# 背景 (実際に3回起きた事故): #519/#522/#523/#524 (→#528で事後回収),
# #540 (→#542でリカバリ), #539 (→#547でリカバリ)。
#
# 根本原因 (実際のPRデータをgh apiで検証済み):
#   子PR(base=親featureブランチ)を作成 → 親PR(base=main)が先にmerge →
#   しかし親ブランチが削除されなかった(またはretargetのタイミング前)ため、
#   子PRのbaseは親featureブランチのままGitHub側で自動retargetされない →
#   その状態で子PRをmergeすると、squash commitは親ブランチに着地し、mainには
#   一切届かない(親ブランチのtipはsquash mergeによりmainの祖先にならないため
#   `git merge-base --is-ancestor` では検知できない — 実際に検証済み)。
#   GitHub上はどちらもMERGED表示になるため、誰も気づけない。
#
# 検知方法:
#   open PRのうちbase≠mainのものについて、「そのbaseブランチ名を headRefName とし
#   base=main でMERGED済みのPRが存在するか」をgh pr listで調べる。存在すれば、
#   「親は既にmainへ入っている」ことが確定するので警告する。
#   (git ancestor判定はsquash mergeで壊れるため使わない。GitHub PR履歴ベースの
#   判定のみが確実)
#
# 正当なスタック作業中(親のPRがまだmainへmergeされていない)は検知対象外。
# ラベル付与・コメント投稿は冪等(重複しない)。
#
# 使い方:
#   bash SCRIPTS/stacked-pr-guard.sh                # open PR全件を走査して警告
#   bash SCRIPTS/stacked-pr-guard.sh --dry-run       # 判定のみ(ラベル付与・コメントしない)
#   bash SCRIPTS/stacked-pr-guard.sh --self-test     # 純粋判定ロジックの単体確認
#
# 環境変数:
#   GH_REPO   owner/repo (default: milechy/commerce-faq-tasks)
#   WARN_LABEL 警告ラベル名 (default: needs-review。リポジトリに既存のラベルを再利用)
#
# 依存: gh, jq

set -euo pipefail

GH_REPO="${GH_REPO:-milechy/commerce-faq-tasks}"
WARN_LABEL="${WARN_LABEL:-needs-review}"
WARN_MARKER='<!-- stacked-pr-guard: stale-base-warning -->'

log() { printf '[stacked-pr-guard] %s\n' "$*" >&2; }

# ─── 純粋判定ヘルパー (self-test 対象) ───────────────────────────────────────

# 引数1: PRのbaseRefName。引数2: `gh pr list --head <base> --state merged
#   --json baseRefName,state` 相当のJSON配列文字列。
# 0=stale(親は既にmainへmerge済み。警告すべき)、1=正常(スタック作業中、または該当PRなし)
is_stale_stacked_base() {
  local matches_json="$1"
  local hit
  hit="$(printf '%s' "$matches_json" | jq -r \
    '[.[] | select(.baseRefName=="main" and .state=="MERGED")] | length')"
  [[ "$hit" -gt 0 ]]
}

# 既存ラベル一覧(改行区切り)に WARN_LABEL が含まれるか。0=含まれる(付与不要)。
has_warn_label() {
  local labels_csv="$1"
  printf '%s' "$labels_csv" | tr ',' '\n' | grep -qx "$WARN_LABEL"
}

# 既存コメント本文の配列(JSON, [{"body":"..."}]) に WARN_MARKER を含むものがあるか。
# 0=既に警告済み(再投稿不要)
has_warned_comment() {
  local comments_json="$1"
  printf '%s' "$comments_json" | jq -e --arg m "$WARN_MARKER" \
    '[.[] | select(.body | contains($m))] | length > 0' >/dev/null 2>&1
}

# ─── self-test ───────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--self-test" ]]; then
  fail=0

  MERGED_TO_MAIN='[{"baseRefName":"main","state":"MERGED"}]'
  if is_stale_stacked_base "$MERGED_TO_MAIN"; then
    echo "PASS stale: 親がmainへmerge済み(headRefName一致)を検出"
  else
    echo "FAIL stale: 親merge済みを見逃した"; fail=1
  fi

  STILL_OPEN='[]'
  if is_stale_stacked_base "$STILL_OPEN"; then
    echo "FAIL stale: 該当PRなし(正当なスタック中)を誤検知"; fail=1
  else
    echo "PASS stale: 正当なスタック作業中(親未マージ)は誤検知しない"
  fi

  MERGED_ELSEWHERE='[{"baseRefName":"feature/parent-of-parent","state":"MERGED"}]'
  if is_stale_stacked_base "$MERGED_ELSEWHERE"; then
    echo "FAIL stale: main以外へのmergeを誤検知"; fail=1
  else
    echo "PASS stale: 親がさらに別ブランチへmerge済み(main未到達)は誤検知しない"
  fi

  STILL_OPEN_PR='[{"baseRefName":"main","state":"OPEN"}]'
  if is_stale_stacked_base "$STILL_OPEN_PR"; then
    echo "FAIL stale: 親PRがOPENのままなのに誤検知"; fail=1
  else
    echo "PASS stale: 親PRがOPEN(未merge)は誤検知しない"
  fi

  if has_warn_label "needs-review,foo"; then
    echo "PASS label: 既存ラベルを検出(重複付与しない判定)"
  else
    echo "FAIL label: 既存ラベルを見逃した"; fail=1
  fi
  if has_warn_label "bug,enhancement"; then
    echo "FAIL label: 無関係ラベルを誤検出"; fail=1
  else
    echo "PASS label: 未付与を正しく検出"
  fi

  COMMENTS_WARNED='[{"body":"some text"},{"body":"prefix <!-- stacked-pr-guard: stale-base-warning --> suffix"}]'
  if has_warned_comment "$COMMENTS_WARNED"; then
    echo "PASS comment: 既存警告コメントを検出(重複投稿しない判定)"
  else
    echo "FAIL comment: 既存警告コメントを見逃した"; fail=1
  fi
  COMMENTS_NONE='[{"body":"unrelated comment"}]'
  if has_warned_comment "$COMMENTS_NONE"; then
    echo "FAIL comment: 無関係コメントを誤検出"; fail=1
  else
    echo "PASS comment: 未投稿を正しく検出"
  fi

  echo "---"; [[ "$fail" == 0 ]] && { echo "✅ self-test PASS"; exit 0; } || { echo "❌ self-test FAIL"; exit 1; }
fi

# ─── 実行本体 ──────────────────────────────────────────────────────────────
for cmd in gh jq; do command -v "$cmd" >/dev/null 2>&1 || { log "missing: $cmd"; exit 2; }; done

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

# base≠main の open PR 一覧を取得
CANDIDATES_JSON="$(gh pr list --repo "$GH_REPO" --state open --json number,baseRefName,labels \
  --jq '[.[] | select(.baseRefName != "main")]' 2>/dev/null || echo '[]')"

COUNT="$(printf '%s' "$CANDIDATES_JSON" | jq 'length')"
log "base≠main の open PR: ${COUNT}件"

if [[ "$COUNT" == "0" ]]; then
  log "対象なし。終了。"
  exit 0
fi

# 1件分の処理。失敗しても呼び出し側で継続できるよう、ここでは exit させず return で返す。
process_one_pr() {
  local pr="$1"
  local PR_NUM BASE LABELS_CSV MATCHES_JSON COMMENTS_JSON BODY
  PR_NUM="$(jq -r '.number' <<<"$pr")"
  BASE="$(jq -r '.baseRefName' <<<"$pr")"
  LABELS_CSV="$(jq -r '[.labels[].name] | join(",")' <<<"$pr")"

  MATCHES_JSON="$(gh pr list --repo "$GH_REPO" --head "$BASE" --state merged \
    --json baseRefName,state 2>/dev/null || echo '[]')"

  if ! is_stale_stacked_base "$MATCHES_JSON"; then
    log "PR #${PR_NUM} (base=${BASE}): 親は未mainマージ — 正当なスタック作業中、スキップ"
    return 0
  fi

  log "PR #${PR_NUM} (base=${BASE}): ⚠️ 親ブランチは既にmainへmerge済み。base差し替えが必要"

  if [[ "$DRY_RUN" == "1" ]]; then
    log "  DRY-RUN: ラベル付与・コメント投稿はスキップ"
    return 0
  fi

  if has_warn_label "$LABELS_CSV"; then
    log "  ラベル '${WARN_LABEL}' は付与済み — スキップ"
  else
    if gh pr edit "$PR_NUM" --repo "$GH_REPO" --add-label "$WARN_LABEL" 2>&1 | sed 's/^/[stacked-pr-guard]   /' >&2; then
      log "  ✓ ラベル '${WARN_LABEL}' を付与"
    else
      log "  ⚠ ラベル付与に失敗 (権限/API制限の可能性) — 次回sweepで再試行"
    fi
  fi

  COMMENTS_JSON="$(gh api "repos/${GH_REPO}/issues/${PR_NUM}/comments" --jq '[.[] | {body: .body}]' 2>/dev/null || echo '[]')"
  if has_warned_comment "$COMMENTS_JSON"; then
    log "  警告コメントは投稿済み — スキップ"
    return 0
  fi

  BODY="$(cat <<EOF
${WARN_MARKER}
⚠️ **スタックPRの base が古くなっています**

このPRの base (\`${BASE}\`) は、既に \`main\` へマージ済みの別PRの head です。
このまま merge すると squash commit が \`${BASE}\` に着地し、**main には届きません**
(実際に #528 / #540 / #539 で同じ事故が発生しています)。

対応: base を \`main\` に retarget するか、\`main\` から新しいブランチを切って
このPRの差分を作り直し、\`base=main\` の新しいPRとして出し直してください
(過去の復旧例: #542, #547)。

このコメントは \`SCRIPTS/stacked-pr-guard.sh\` による自動警告です。
EOF
)"
  if gh pr comment "$PR_NUM" --repo "$GH_REPO" --body "$BODY" 2>&1 | sed 's/^/[stacked-pr-guard]   /' >&2; then
    log "  ✓ 警告コメントを投稿"
  else
    log "  ⚠ コメント投稿に失敗 (権限/API制限の可能性) — 次回sweepで再試行"
  fi
  return 0
}

printf '%s' "$CANDIDATES_JSON" | jq -c '.[]' | while IFS= read -r pr; do
  process_one_pr "$pr" || log "  ⚠ このPRの処理中にエラー — 次のPRへ続行"
done

log "done"
