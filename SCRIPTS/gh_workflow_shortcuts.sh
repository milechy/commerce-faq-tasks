#!/usr/bin/env bash
# GitHub Issues/PRの最小ショートカット集（Projects不要）

set -euo pipefail

OWNER="milechy"
REPO="commerce-faq-tasks"

# 例: ./gh_workflow_shortcuts.sh new "タイトル" "本文" type:feat status:todo prio:high phase:api
cmd="${1:-}"; shift || true

case "$cmd" in
  new)
    title="$1"; body="$2"; shift 2 || true
    labels="${*:-status:todo,prio:medium,type:feat,phase:api}"
    gh issue create -R "$OWNER/$REPO" --title "$title" --body "$body" --label "$labels" --assignee "@me"
    ;;
  start)
    num="$1"
    gh issue edit "$num" -R "$OWNER/$REPO" --add-label "status:in-progress" --remove-label "status:todo"
    ;;
  review)
    num="$1"
    gh issue edit "$num" -R "$OWNER/$REPO" --add-label "status:review" --remove-label "status:in-progress"
    ;;
  qa)
    num="$1"
    gh issue edit "$num" -R "$OWNER/$REPO" --add-label "status:qa" --remove-label "status:review"
    ;;
  done)
    num="$1"
    gh issue edit "$num" -R "$OWNER/$REPO" --add-label "status:done" \
      --remove-label "status:qa" --remove-label "status:review" --remove-label "status:in-progress" --remove-label "status:todo"
    ;;
  branch)
    num="$1"; type="${2:-feat}"; slug="${3:-task}"
    br="${type}/${slug}-${num}"
    git checkout -b "$br"
    echo "$br"
    ;;
  pr)
    num="$1"; br="$(git rev-parse --abbrev-ref HEAD)"
    gh pr create -R "$OWNER/$REPO" -B main -H "$br" \
      -t "Task #$num — ${br}" -b $'実装詳細...\n\nCloses #'"$num"
    ;;
  *)
    cat <<'USAGE'
Usage:
  new "<title>" "<body>" [labels...]
  start <num> | review <num> | qa <num> | done <num>
  branch <num> [type] [slug]
  pr <num>
USAGE
    ;;
esac