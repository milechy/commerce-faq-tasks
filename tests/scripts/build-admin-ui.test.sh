#!/usr/bin/env bash
# tests/scripts/build-admin-ui.test.sh
# build-admin-ui.sh のロジック部分をユニットテスト（実ビルドなし）。
# テスト対象: env 読み込み/空値チェック/プロジェクトID抽出/bundle検証ロジック
set -euo pipefail

TMPDIR_BASE="$(mktemp -d)"
PASS=0
FAIL=0

cleanup() { rm -rf "${TMPDIR_BASE}"; }
trap cleanup EXIT

ok()   { echo "  ✅ PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ FAIL: $1"; FAIL=$((FAIL+1)); }

# ── env 解析ロジック（build-admin-ui.sh から抽出） ──────────────
parse_env_file() {
  local env_file="$1"
  VITE_SUPABASE_URL=""
  VITE_SUPABASE_ANON_KEY=""
  VITE_API_BASE=""

  [ ! -f "$env_file" ] && return 1

  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^#.*$ ]] && continue
    [[ -z "$line" ]] && continue
    local key="${line%%=*}"
    local value="${line#*=}"
    case "$key" in
      VITE_SUPABASE_URL)      VITE_SUPABASE_URL="$value" ;;
      VITE_SUPABASE_ANON_KEY) VITE_SUPABASE_ANON_KEY="$value" ;;
      VITE_API_BASE)          VITE_API_BASE="$value" ;;
    esac
  done < "$env_file"

  [ -z "${VITE_SUPABASE_URL}" ]      && echo "FATAL:EMPTY_URL"   && return 1
  [ -z "${VITE_SUPABASE_ANON_KEY}" ] && echo "FATAL:EMPTY_KEY"   && return 1
  [ -z "${VITE_API_BASE}" ]          && echo "FATAL:EMPTY_BASE"  && return 1
  return 0
}

# ── bundle 検証ロジック（build-admin-ui.sh から抽出） ───────────
verify_bundle() {
  local bundle_file="$1"
  local supabase_url="$2"

  local project_id
  project_id=$(echo "$supabase_url" | sed -E 's|https://([^.]+)\..*|\1|')
  [ -z "$project_id" ] && echo "FATAL:NO_PROJECT_ID" && return 1

  grep -q "not-configured.invalid" "$bundle_file" && \
    echo "FATAL:FALLBACK_FOUND" && return 1

  grep -q "$project_id" "$bundle_file" || \
    { echo "FATAL:PROJECT_ID_MISSING"; return 1; }

  echo "OK"
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ケース1: 有効な .env.local → 全キー読み込み成功
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo "Case 1: 有効な .env.local → 全キー読み込み成功"
ENV1="${TMPDIR_BASE}/env1"
cat > "$ENV1" << 'ENVEOF'
VITE_SUPABASE_URL=https://rpqrwifbrhlebbelyqog.supabase.co
VITE_SUPABASE_ANON_KEY=eyJdummy
VITE_API_BASE=https://api.r2c.biz
ENVEOF

if parse_env_file "$ENV1"; then
  [ "$VITE_SUPABASE_URL" = "https://rpqrwifbrhlebbelyqog.supabase.co" ] && \
  [ "$VITE_SUPABASE_ANON_KEY" = "eyJdummy" ] && \
  [ "$VITE_API_BASE" = "https://api.r2c.biz" ] && \
    ok "全キー正常読み込み" || fail "値が期待値と一致しない"
else
  fail "parse_env_file が失敗"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ケース2: VITE_SUPABASE_URL が空 → エラー
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo "Case 2: VITE_SUPABASE_URL が空 → エラー"
ENV2="${TMPDIR_BASE}/env2"
cat > "$ENV2" << 'ENVEOF'
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=eyJdummy
VITE_API_BASE=https://api.r2c.biz
ENVEOF

OUTPUT=$(parse_env_file "$ENV2" 2>&1 || true)
if [[ "$OUTPUT" == *"FATAL:EMPTY_URL"* ]]; then
  ok "空URL → FATAL:EMPTY_URL 検出"
else
  fail "空URLを検出できなかった: '$OUTPUT'"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ケース3: .env.local が存在しない → エラー
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo "Case 3: .env.local が存在しない → エラー"
MISSING="${TMPDIR_BASE}/does_not_exist"
if parse_env_file "$MISSING" 2>/dev/null; then
  fail "存在しないファイルでエラーにならなかった"
else
  ok ".env.local 不在 → 非ゼロ終了"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ケース4: コメント行・空行のスキップ
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo "Case 4: コメント行・空行を含む .env → 正常読み込み"
ENV4="${TMPDIR_BASE}/env4"
cat > "$ENV4" << 'ENVEOF'
# コメント行
VITE_SUPABASE_URL=https://rpqrwifbrhlebbelyqog.supabase.co

# 別のコメント
VITE_SUPABASE_ANON_KEY=eyJdummy
VITE_API_BASE=https://api.r2c.biz
ENVEOF

if parse_env_file "$ENV4" && [ -n "$VITE_SUPABASE_URL" ]; then
  ok "コメント・空行スキップ → 正常読み込み"
else
  fail "コメント行でパース失敗"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ケース5: プロジェクトID抽出
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo "Case 5: Supabase プロジェクトID抽出"
URL="https://rpqrwifbrhlebbelyqog.supabase.co"
ID=$(echo "$URL" | sed -E 's|https://([^.]+)\..*|\1|')
[ "$ID" = "rpqrwifbrhlebbelyqog" ] && \
  ok "プロジェクトID抽出成功: $ID" || \
  fail "抽出失敗: got '$ID'"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ケース6: bundle検証 — not-configured フォールバック検出
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo "Case 6: bundle にフォールバック値あり → FAIL"
BAD_BUNDLE="${TMPDIR_BASE}/bad-bundle.js"
echo 'const x="https://not-configured.invalid"' > "$BAD_BUNDLE"
OUTPUT=$(verify_bundle "$BAD_BUNDLE" "https://rpqrwifbrhlebbelyqog.supabase.co" 2>&1 || true)
[[ "$OUTPUT" == *"FATAL:FALLBACK_FOUND"* ]] && \
  ok "フォールバック値 → FATAL:FALLBACK_FOUND 検出" || \
  fail "フォールバック値を検出できなかった: '$OUTPUT'"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ケース7: bundle検証 — プロジェクトIDなし → FAIL
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo "Case 7: bundle にプロジェクトIDなし → FAIL"
EMPTY_BUNDLE="${TMPDIR_BASE}/empty-bundle.js"
echo 'const x="some other content"' > "$EMPTY_BUNDLE"
OUTPUT=$(verify_bundle "$EMPTY_BUNDLE" "https://rpqrwifbrhlebbelyqog.supabase.co" 2>&1 || true)
[[ "$OUTPUT" == *"FATAL:PROJECT_ID_MISSING"* ]] && \
  ok "プロジェクトIDなし → FATAL:PROJECT_ID_MISSING 検出" || \
  fail "プロジェクトID欠如を検出できなかった: '$OUTPUT'"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# ケース8: bundle検証 — 正常bundle → OK
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo "Case 8: 正常 bundle → OK"
GOOD_BUNDLE="${TMPDIR_BASE}/good-bundle.js"
echo 'const x="https://rpqrwifbrhlebbelyqog.supabase.co"' > "$GOOD_BUNDLE"
OUTPUT=$(verify_bundle "$GOOD_BUNDLE" "https://rpqrwifbrhlebbelyqog.supabase.co" 2>&1 || true)
[ "$OUTPUT" = "OK" ] && \
  ok "正常bundle → OK" || \
  fail "正常bundleでOKが返らなかった: '$OUTPUT'"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 結果サマリー
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo "=== テスト結果: PASS=${PASS} FAIL=${FAIL} ==="
[ "${FAIL}" -eq 0 ] && echo "✅ 全テスト通過" && exit 0
echo "❌ ${FAIL}件失敗" && exit 1
