#!/bin/bash
# deploy_guard.py のテスト

GUARD=".claude/hooks/deploy_guard.py"
PASS=0
FAIL=0

test_case() {
  local desc="$1"
  local input="$2"
  local expected_exit="$3"

  echo "$input" | python3 "$GUARD" 2>/dev/null
  actual=$?

  if [ "$actual" -eq "$expected_exit" ]; then
    echo "✅ $desc (exit=$actual)"
    ((PASS++))
  else
    echo "❌ $desc (expected=$expected_exit, actual=$actual)"
    ((FAIL++))
  fi
}

echo "=== deploy_guard.py テスト ==="

# 許可されるコマンド
test_case "allowed: deploy-vps.sh" \
  '{"tool_name":"Bash","tool_input":{"command":"bash SCRIPTS/deploy-vps.sh"}}' 0

test_case "allowed: pm2 restart avatar" \
  '{"tool_name":"Bash","tool_input":{"command":"pm2 restart rajiuce-avatar"}}' 0

test_case "allowed: non-deploy command" \
  '{"tool_name":"Bash","tool_input":{"command":"pnpm verify"}}' 0

test_case "allowed: non-Bash tool" \
  '{"tool_name":"Read","tool_input":{"path":"src/index.ts"}}' 0

# ブロックされるコマンド
test_case "blocked: manual git pull on VPS" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"git pull && pnpm build && pm2 restart rajiuce-api\""}}' 2

test_case "blocked: manual pm2 restart api" \
  '{"tool_name":"Bash","tool_input":{"command":"pm2 restart rajiuce-api"}}' 2

test_case "blocked: semicolon bypass" \
  '{"tool_name":"Bash","tool_input":{"command":"echo hi; pm2 restart rajiuce-api"}}' 2

test_case "blocked: newline bypass" \
  "$(printf '{"tool_name":"Bash","tool_input":{"command":"echo hi\npm2 restart rajiuce-api"}}')" 2

test_case "blocked: rsync manual" \
  '{"tool_name":"Bash","tool_input":{"command":"rsync -avz . root@65.108.159.161:/opt/rajiuce"}}' 2

# fail-closed
test_case "fail-closed: malformed JSON" \
  'not valid json' 2

test_case "fail-closed: empty input" \
  '' 2

test_case "fail-closed: missing tool_name" \
  '{"tool_input":{"command":"ls"}}' 2

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
