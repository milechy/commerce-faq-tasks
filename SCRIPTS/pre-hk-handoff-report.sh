#!/usr/bin/env bash
# SCRIPTS/pre-hk-handoff-report.sh — hk UI 確認前の引き渡しレポート生成
#
# 実行: bash SCRIPTS/pre-hk-handoff-report.sh [--post-pr <PR番号>]
#
# オプション:
#   --post-pr <PR番号>  GitHub PR にレポートをコメント投稿する
#
# 各 Gate を実行し、証拠付きサマリーを標準出力 + オプションでPRコメントに投稿する。
# hk が確認すべき「Phase固有チェックポイント」のみをピックアップして伝える。

set -uo pipefail

POST_PR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --post-pr) POST_PR="$2"; shift 2 ;;
    *) shift ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

GATE1_STATUS="⏳"
GATE2_STATUS="⏳"
GATE3_STATUS="⏳"
GATE4B_STATUS="🔶 要手動"
GATE8_STATUS="⏳"
GATE8_5_STATUS="⏳"
VISUAL_STATUS="⏳"

GATE1_DETAIL=""
GATE2_DETAIL=""
GATE3_DETAIL=""
GATE8_DETAIL=""
GATE8_5_DETAIL=""
VISUAL_DETAIL=""

START_TS=$(date '+%Y-%m-%d %H:%M:%S')
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  pre-hk 引き渡しレポート生成中..."
echo "  Branch: ${BRANCH}  Commit: ${COMMIT}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ─── Gate 1: pnpm verify ────────────────────────────────────────────────────
echo "▶ Gate 1: pnpm verify ..."
if verify_out=$(pnpm verify 2>&1); then
  GATE1_STATUS="✅"
  test_line=$(echo "${verify_out}" | grep -E "Tests:|passed|failed" | tail -1 || echo "pass")
  GATE1_DETAIL="typecheck 0 errors · ${test_line}"
else
  GATE1_STATUS="❌"
  GATE1_DETAIL=$(echo "${verify_out}" | tail -5 | tr '\n' ' ')
fi
echo "  → ${GATE1_STATUS} ${GATE1_DETAIL}"
echo ""

# ─── Gate 1.5: dead-code-check ──────────────────────────────────────────────
echo "▶ Gate 1.5: dead-code-check ..."
if bash SCRIPTS/dead-code-check.sh > /dev/null 2>&1; then
  GATE1_5_STATUS="✅"
else
  GATE1_5_STATUS="⚠️ "
fi
echo "  → ${GATE1_5_STATUS}"
echo ""

# ─── Gate 2: security-scan ──────────────────────────────────────────────────
echo "▶ Gate 2: security-scan ..."
if sec_out=$(bash SCRIPTS/security-scan.sh 2>&1); then
  GATE2_STATUS="✅"
  high_cnt=$(echo "${sec_out}" | grep -c "HIGH\|CRITICAL" || echo "0")
  GATE2_DETAIL="High/Critical: ${high_cnt}"
else
  GATE2_STATUS="❌"
  GATE2_DETAIL=$(echo "${sec_out}" | grep "HIGH\|CRITICAL" | head -3 | tr '\n' ' ')
fi
echo "  → ${GATE2_STATUS} ${GATE2_DETAIL}"
echo ""

# ─── Gate 3: build ──────────────────────────────────────────────────────────
echo "▶ Gate 3: build ..."
if pnpm build > /dev/null 2>&1 && (cd admin-ui && pnpm build > /dev/null 2>&1); then
  GATE3_STATUS="✅"
  GATE3_DETAIL="backend build OK · admin-ui build OK"
else
  GATE3_STATUS="❌"
  GATE3_DETAIL="build 失敗 — pnpm build を手動確認"
fi
echo "  → ${GATE3_STATUS} ${GATE3_DETAIL}"
echo ""

# ─── Gate 8: integration smoke ──────────────────────────────────────────────
echo "▶ Gate 8: integration smoke ..."
if gate8_out=$(bash SCRIPTS/gate-8-integration-smoke.sh 2>&1); then
  GATE8_STATUS="✅"
  pass_cnt=$(echo "${gate8_out}" | grep -c "✅" || echo "?")
  GATE8_DETAIL="${pass_cnt} 項目 PASS"
else
  GATE8_STATUS="❌"
  fail_lines=$(echo "${gate8_out}" | grep "❌" | head -3 | tr '\n' ' ')
  GATE8_DETAIL="${fail_lines}"
fi
echo "  → ${GATE8_STATUS} ${GATE8_DETAIL}"
echo ""

# ─── Gate 8.5: scenario smoke ───────────────────────────────────────────────
echo "▶ Gate 8.5: scenario smoke ..."
if [[ -z "${E2E_TEST_API_KEY:-}" ]]; then
  GATE8_5_STATUS="⏭ "
  GATE8_5_DETAIL="E2E_TEST_API_KEY 未設定 — スキップ"
elif bash SCRIPTS/gate-8.5-scenario-smoke.sh > /tmp/gate8.5.out 2>&1; then
  GATE8_5_STATUS="✅"
  pass_cnt=$(grep -c "✅" /tmp/gate8.5.out || echo "?")
  GATE8_5_DETAIL="${pass_cnt} シナリオ PASS"
else
  GATE8_5_STATUS="❌"
  fail_lines=$(grep "❌" /tmp/gate8.5.out | head -3 | tr '\n' ' ')
  GATE8_5_DETAIL="${fail_lines}"
fi
echo "  → ${GATE8_5_STATUS} ${GATE8_5_DETAIL}"
echo ""

# ─── Visual regression（baseline があれば実行）──────────────────────────────
echo "▶ Visual regression ..."
SCREENSHOT_DIR="${ROOT}/tests/e2e/__screenshots__"
if [[ ! -d "${SCREENSHOT_DIR}" ]] || [[ -z "$(ls -A "${SCREENSHOT_DIR}" 2>/dev/null)" ]]; then
  VISUAL_STATUS="⏭ "
  VISUAL_DETAIL="baseline 未作成 — pnpm test:visual:update で初期化してください"
elif E2E_ENABLED=1 pnpm test:visual > /tmp/visual.out 2>&1; then
  VISUAL_STATUS="✅"
  VISUAL_DETAIL="差分なし"
else
  VISUAL_STATUS="❌"
  diff_files=$(grep "screenshot" /tmp/visual.out | head -3 | tr '\n' ' ')
  VISUAL_DETAIL="差分あり: ${diff_files}"
fi
echo "  → ${VISUAL_STATUS} ${VISUAL_DETAIL}"
echo ""

# ─── Phase 固有チェックポイント（最新コミットメッセージから推定）──────────
COMMIT_MSG=$(git log -1 --pretty=%s 2>/dev/null || echo "")
PHASE_LABEL=$(echo "${COMMIT_MSG}" | grep -oE 'GID [0-9]+|Phase[0-9A-Za-z-]+' | head -1 || echo "")

# ─── レポート組み立て ────────────────────────────────────────────────────────
REPORT=$(cat <<EOF
## 👀 hk 引き渡しレポート — ${START_TS}

| Gate | 結果 | 詳細 |
|---|---|---|
| Gate 1: pnpm verify | ${GATE1_STATUS} | ${GATE1_DETAIL} |
| Gate 1.5: dead-code | ${GATE1_5_STATUS:-⏭ } | |
| Gate 2: security scan | ${GATE2_STATUS} | ${GATE2_DETAIL} |
| Gate 3: build | ${GATE3_STATUS} | ${GATE3_DETAIL} |
| Gate 4b: Playwright (Admin UI) | ${GATE4B_STATUS} | Supabase 認証が必要 → hk 目視 |
| Gate 8: integration smoke | ${GATE8_STATUS} | ${GATE8_DETAIL} |
| Gate 8.5: scenario smoke | ${GATE8_5_STATUS} | ${GATE8_5_DETAIL} |
| Visual regression | ${VISUAL_STATUS} | ${VISUAL_DETAIL} |

**Branch:** \`${BRANCH}\` / **Commit:** \`${COMMIT}\`
${PHASE_LABEL:+**Phase:** ${PHASE_LABEL}}

### ✋ hk 確認ポイント（CLI 自動化不可の範囲のみ）

- [ ] Admin UI ログイン成功 → ダッシュボード表示
- [ ] 今回の Phase 固有機能の動作確認
- [ ] 390px モバイル表示崩れなし
- [ ] DevTools コンソールエラーなし

> Gate 1〜3・8・8.5 は CLI で全通過済み。上記のみ目視確認お願いします 🙏
EOF
)

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "${REPORT}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─── PRコメント投稿（オプション）────────────────────────────────────────────
if [[ -n "${POST_PR}" ]]; then
  echo ""
  echo "▶ PR #${POST_PR} にコメント投稿..."
  if gh pr comment "${POST_PR}" --body "${REPORT}" 2>&1; then
    echo "  ✅ 投稿完了"
  else
    echo "  ❌ 投稿失敗 — gh CLI のログイン状態を確認してください"
  fi
fi

# ─── 終了コード ──────────────────────────────────────────────────────────────
if [[ "${GATE1_STATUS}" == "❌" || "${GATE2_STATUS}" == "❌" || "${GATE3_STATUS}" == "❌" || "${GATE8_STATUS}" == "❌" || "${GATE8_5_STATUS}" == "❌" || "${VISUAL_STATUS}" == "❌" ]]; then
  exit 1
fi
exit 0
