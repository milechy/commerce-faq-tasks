#!/usr/bin/env bash
# new_task "<タイトル>" "<本文>"
set -euo pipefail
OWNER="milechy"
REPO="commerce-faq-tasks"

title="${1:?title required}"
body="${2:-}"

gh issue create -R "$OWNER/$REPO" \
  --title "$title" \
  --body "$body" \
  --label "status:todo" --label "prio:medium" --label "type:feat" --label "phase:api" \
  --assignee "@me"