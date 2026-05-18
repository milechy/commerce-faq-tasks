#!/usr/bin/env bash
# verify-account-isolation.sh
# ~/.claude/ と ~/.claude-r2c-config/ の独立性を確認する。
# PHASE1_ACCOUNT_MIGRATION_RUNBOOK.md Step 6 で実行。

set -euo pipefail

PASS=0
FAIL=0
WARN=0

ok()   { echo "  PASS: $*"; ((PASS++));  }
fail() { echo "  FAIL: $*"; ((FAIL++));  }
warn() { echo "  WARN: $*"; ((WARN++)); }

CLAUDE_DIR="${HOME}/.claude"
R2C_DIR="${HOME}/.claude-r2c-config"
SECRETS_DIR="${R2C_DIR}/secrets"

echo ""
echo "=== Claude Code アカウント分離 検証 ==="
echo ""

# ------------------------------------------------------------------
# 1. ディレクトリ存在チェック
# ------------------------------------------------------------------
echo "-- 1. ディレクトリ存在"

if [ -d "${CLAUDE_DIR}" ]; then
  ok "${CLAUDE_DIR} 存在"
else
  fail "${CLAUDE_DIR} が存在しない (元の config が消えている)"
fi

if [ -d "${R2C_DIR}" ]; then
  ok "${R2C_DIR} 存在"
else
  fail "${R2C_DIR} が存在しない (移行未完了)"
fi

# ------------------------------------------------------------------
# 2. パーミッションチェック
# ------------------------------------------------------------------
echo ""
echo "-- 2. パーミッション"

if [ -d "${R2C_DIR}" ]; then
  # macOS: stat -f "%Lp"  / Linux: stat -c "%a"
  R2C_MODE=$(stat -f "%Lp" "${R2C_DIR}" 2>/dev/null || stat -c "%a" "${R2C_DIR}" 2>/dev/null || echo "unknown")
  if [ "${R2C_MODE}" = "700" ]; then
    ok "${R2C_DIR} mode 700"
  else
    fail "${R2C_DIR} mode は ${R2C_MODE} (700 でなければならない)"
  fi
fi

if [ -d "${SECRETS_DIR}" ]; then
  SEC_MODE=$(stat -f "%Lp" "${SECRETS_DIR}" 2>/dev/null || stat -c "%a" "${SECRETS_DIR}" 2>/dev/null || echo "unknown")
  if [ "${SEC_MODE}" = "700" ]; then
    ok "${SECRETS_DIR} mode 700"
  else
    fail "${SECRETS_DIR} mode は ${SEC_MODE} (700 でなければならない)"
  fi
else
  fail "${SECRETS_DIR} が存在しない"
fi

# ------------------------------------------------------------------
# 3. alias チェック
# ------------------------------------------------------------------
echo ""
echo "-- 3. alias"

ZSHRC="${HOME}/.zshrc"
if [ -f "${ZSHRC}" ] && grep -q 'claude-r2c' "${ZSHRC}"; then
  ok ".zshrc に claude-r2c alias が存在"
else
  fail ".zshrc に claude-r2c alias が存在しない"
fi

if type claude-r2c > /dev/null 2>&1; then
  ok "claude-r2c コマンドが解決できる"
else
  warn "claude-r2c コマンドが未解決 (source ~/.zshrc を実行していない可能性)"
fi

# ------------------------------------------------------------------
# 4. 独立性チェック（書き込みが分離されているか）
# ------------------------------------------------------------------
echo ""
echo "-- 4. ディレクトリ独立性"

if [ -d "${CLAUDE_DIR}" ] && [ -d "${R2C_DIR}" ]; then
  # 同一 inode でないことを確認（symlink / bind-mount 検出）
  INODE_CLAUDE=$(find "${CLAUDE_DIR}" -maxdepth 0 -printf "%i\n" 2>/dev/null || stat -f "%i" "${CLAUDE_DIR}" 2>/dev/null || echo "0")
  INODE_R2C=$(find "${R2C_DIR}" -maxdepth 0 -printf "%i\n" 2>/dev/null || stat -f "%i" "${R2C_DIR}" 2>/dev/null || echo "1")
  if [ "${INODE_CLAUDE}" != "${INODE_R2C}" ]; then
    ok "${CLAUDE_DIR} と ${R2C_DIR} は別 inode (独立コピー)"
  else
    fail "${CLAUDE_DIR} と ${R2C_DIR} が同一 inode (シンボリックリンクの疑い)"
  fi

  # テストファイルによる書き込み分離確認
  TEST_FILE=".isolation-test-$$"
  touch "${R2C_DIR}/${TEST_FILE}"
  if [ -f "${CLAUDE_DIR}/${TEST_FILE}" ]; then
    fail "${R2C_DIR} への書き込みが ${CLAUDE_DIR} に反映された (分離失敗)"
    rm -f "${CLAUDE_DIR}/${TEST_FILE}" "${R2C_DIR}/${TEST_FILE}"
  else
    ok "書き込み分離確認: ${R2C_DIR} への書き込みは ${CLAUDE_DIR} に影響しない"
    rm -f "${R2C_DIR}/${TEST_FILE}"
  fi
fi

# ------------------------------------------------------------------
# 5. settings.json 存在チェック
# ------------------------------------------------------------------
echo ""
echo "-- 5. 設定ファイル"

if [ -f "${R2C_DIR}/settings.json" ]; then
  ok "${R2C_DIR}/settings.json 存在"
else
  warn "${R2C_DIR}/settings.json が存在しない (初回起動時に生成される可能性あり)"
fi

if [ -f "${CLAUDE_DIR}/settings.json" ]; then
  ok "${CLAUDE_DIR}/settings.json 存在 (元の config は intact)"
else
  warn "${CLAUDE_DIR}/settings.json が存在しない"
fi

# ------------------------------------------------------------------
# 6. CLAUDE_CONFIG_DIR 環境変数チェック
# ------------------------------------------------------------------
echo ""
echo "-- 6. 環境変数"

if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  if [ "${CLAUDE_CONFIG_DIR}" = "${R2C_DIR}" ]; then
    ok "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR} (R2C 専用)"
  else
    warn "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR} (R2C 以外のパス。claude-r2c alias 経由か確認)"
  fi
else
  ok "CLAUDE_CONFIG_DIR 未設定 = default ${CLAUDE_DIR} (claude コマンド直接起動の状態)"
fi

# ------------------------------------------------------------------
# 結果サマリ
# ------------------------------------------------------------------
echo ""
echo "=== 結果サマリ ==="
echo "  PASS: ${PASS}"
echo "  WARN: ${WARN}"
echo "  FAIL: ${FAIL}"
echo ""

if [ "${FAIL}" -gt 0 ]; then
  echo "FAIL ${FAIL} 件。PHASE1_ACCOUNT_MIGRATION_RUNBOOK.md のロールバック手順を確認してください。"
  exit 1
elif [ "${WARN}" -gt 0 ]; then
  echo "WARN ${WARN} 件。内容を確認の上、問題なければ続行可。"
  exit 0
else
  echo "全チェック PASS。アカウント分離は正常に完了しています。"
  exit 0
fi
