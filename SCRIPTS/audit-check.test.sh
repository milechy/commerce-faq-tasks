#!/bin/bash
# SCRIPTS/audit-check.test.sh
#
# audit-check.sh の3状態分類を、偽の pnpm を PATH に差し込んで検証する。
# ネットワークに一切依存しないので CI でも数秒で回る。
#
# ★このテストが守っているもの★
# 「レジストリ不通」を「脆弱性あり」と誤分類すると無関係な PR が止まり、
# FAIL の意味が薄れて本物の警告が無視されるようになる。
# 逆に「脆弱性あり」を「不通」と誤分類すると、脆弱性が素通りする。
# どちらへの誤りも起こさないことを、ここで固定する。
#
# Usage: bash SCRIPTS/audit-check.test.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STUB_DIR=$(mktemp -d)
trap 'rm -rf "$STUB_DIR"' EXIT

PASS=0
FAIL=0

# 偽 pnpm を作る。$1=終了コード, $2=標準出力
stub_pnpm() {
  printf '#!/bin/bash\ncat <<'"'"'STUBEOF'"'"'\n%s\nSTUBEOF\nexit %s\n' "$2" "$1" > "$STUB_DIR/pnpm"
  chmod +x "$STUB_DIR/pnpm"
}

# $1=説明, $2=期待status, $3=期待exit
expect() {
  local out rc status
  out=$(cd "$REPO_ROOT" && PATH="$STUB_DIR:$PATH" bash SCRIPTS/audit-check.sh 2>&1)
  rc=$?
  status=$(echo "$out" | grep -o 'AUDIT_STATUS=[a-z_]*' | tail -1 | cut -d= -f2)
  if [[ "$status" == "$2" && "$rc" == "$3" ]]; then
    echo "  ✅ $1"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $1"
    echo "     期待: AUDIT_STATUS=$2 exit=$3"
    echo "     実際: AUDIT_STATUS=$status exit=$rc"
    FAIL=$((FAIL + 1))
  fi
}

echo '=== audit-check.sh 分類テスト ==='

stub_pnpm 0 "No known vulnerabilities found"
expect "到達できて脆弱性なし → clean" clean 0

stub_pnpm 1 "WARN  post https://registry.npmjs.org/-/npm/v1/security/audits error (ERR_SOCKET_TIMEOUT). Will retry in 10 seconds.
 ERR_SOCKET_TIMEOUT  request to https://registry.npmjs.org/ failed, reason: Socket timeout
FetchError: request to https://registry.npmjs.org/ failed"
expect "レジストリ不通 → not_checked（マージを止めない）" not_checked 0

stub_pnpm 1 "ENOTFOUND registry.npmjs.org"
expect "名前解決失敗 → not_checked" not_checked 0

stub_pnpm 1 "┌───────────────┬────────────────────────────┐
│ high          │ Prototype Pollution        │
└───────────────┴────────────────────────────┘
2 vulnerabilities found"
expect "実際に脆弱性あり → vulnerable（止める）" vulnerable 1

stub_pnpm 1 "ERR_SOCKET_TIMEOUT while fetching metadata for one package
┌───────────────┬────────────────────────────┐
│ critical      │ Remote Code Execution      │
└───────────────┴────────────────────────────┘
1 vulnerabilities found"
expect "★不通の痕跡があっても advisory があれば vulnerable★" vulnerable 1

stub_pnpm 1 "something went wrong in an unexpected way"
expect "★判別不能は fail-closed で vulnerable★" vulnerable 1

stub_pnpm 2 "Unhandled internal error"
expect "未知の終了コードも fail-closed" vulnerable 1

echo ''
echo "=== 結果: ${PASS} passed, ${FAIL} failed ==="
[[ $FAIL -eq 0 ]] || exit 1
