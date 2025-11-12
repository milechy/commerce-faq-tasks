#!/usr/bin/env bash
# 初回セットアップ（ラベル作成など）
set -euo pipefail
OWNER="milechy"
REPO="commerce-faq-tasks"

mk() { gh label create "$1" --color "$2" -R "$OWNER/$REPO" >/dev/null 2>&1 || true; }

for l in todo in-progress review qa done; do mk "status:$l" "000000"; done
for l in high medium low; do mk "prio:$l" "C2E0C6"; done
for l in feat bug chore ops; do mk "type:$l" "BFD4F2"; done
for l in db api ui billing monitoring ci; do mk "phase:$l" "FEF2C0"; done

echo "labels ensured on $OWNER/$REPO"