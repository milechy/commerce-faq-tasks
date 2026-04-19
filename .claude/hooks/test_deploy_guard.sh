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

# --- READ_ONLY_SSH_ALLOWLIST: 許可されるべき調査コマンド ---
test_case "allowed: pm2 list" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"pm2 list\""}}' 0

test_case "allowed: pm2 describe rajiuce-api" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"pm2 describe rajiuce-api\""}}' 0

test_case "allowed: pm2 logs with grep" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"pm2 logs rajiuce-api --lines 50 --nostream 2>&1 | grep -iE '\''error'\'' | tail -20\""}}' 0

test_case "allowed: git status on VPS" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"cd /opt/rajiuce && git status\""}}' 0

test_case "allowed: git log on VPS" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"cd /opt/rajiuce && git log --oneline -5\""}}' 0

test_case "allowed: ls /opt/rajiuce/node_modules" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"ls -la /opt/rajiuce/node_modules/adm-zip\""}}' 0

test_case "allowed: test -L symlink check" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"test -L /opt/rajiuce/node_modules/adm-zip && echo '\''yes'\'' || echo '\''no'\''\""}}' 0

test_case "allowed: free -h" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"free -h\""}}' 0

test_case "allowed: df -h /" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"df -h /\""}}' 0

# --- READ_ONLY_SSH_ALLOWLIST: ブロックされるべき危険コマンド ---
test_case "blocked: pm2 restart rajiuce-api (destructive)" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"pm2 restart rajiuce-api\""}}' 2

test_case "blocked: pm2 list with chain injection (&&)" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"pm2 list && rm -rf /\""}}' 2

test_case "blocked: cat /etc/shadow (system path)" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"cat /etc/shadow\""}}' 2

test_case "blocked: sudo ls (sudo attempt)" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"sudo ls\""}}' 2

test_case "blocked: path traversal (..)" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"ls -la /opt/rajiuce/../etc/shadow\""}}' 2

test_case "blocked: leading whitespace before ssh" \
  '{"tool_name":"Bash","tool_input":{"command":" ssh root@65.108.159.161 \"pm2 list\""}}' 2

test_case "blocked: backtick injection" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"ls \`rm -rf /\`\""}}' 2

test_case "blocked: git reset --hard (destructive)" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"cd /opt/rajiuce && git reset --hard origin/main\""}}' 2

test_case "blocked: rm -rf node_modules (destructive)" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"rm -rf /opt/rajiuce/node_modules\""}}' 2

test_case "blocked: pm2 env (exposes production secrets)" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"pm2 env 0\""}}' 2

test_case "blocked: cat npm debug log (may contain tokens)" \
  '{"tool_name":"Bash","tool_input":{"command":"ssh root@65.108.159.161 \"cat /root/.npm/_logs/2026-04-17T10_00_00_000Z-debug-0.log\""}}' 2

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
