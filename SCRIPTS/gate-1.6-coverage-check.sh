#!/usr/bin/env bash
# Gate 1.6: テストカバレッジ判定 (Phase70-I)
#
# 使用方法:
#   bash SCRIPTS/gate-1.6-coverage-check.sh               # 通常チェック (CI 用)
#   bash SCRIPTS/gate-1.6-coverage-check.sh --set-baseline # ベースライン初期設定
#
# ベースラインファイル: .coverage-baseline (git 管理)
# 許容低下幅: MAX_DROP% (デフォルト 2%)
#
# 初回設定手順:
#   1. main ブランチで: bash SCRIPTS/gate-1.6-coverage-check.sh --set-baseline
#   2. git add .coverage-baseline && git commit -m "chore: set Gate 1.6 coverage baseline"
#
set -euo pipefail

BASELINE_FILE=".coverage-baseline"
MAX_DROP=2
SET_BASELINE=false

[[ "${1:-}" == "--set-baseline" ]] && SET_BASELINE=true

echo "=== Gate 1.6: テストカバレッジ判定 ==="

# カバレッジ計測 (json-summary レポーター使用)
echo "[1/3] カバレッジ計測中..."
if ! pnpm test -- --coverage --coverageReporters=json-summary --silent 2>/dev/null; then
    echo "❌ Gate 1.6 FAIL: テスト失敗"
    exit 1
fi

SUMMARY="coverage/coverage-summary.json"
if [[ ! -f "$SUMMARY" ]]; then
    echo "⚠️  カバレッジファイルが見つかりません: $SUMMARY"
    echo "   スキップ (jest coverage 設定を確認してください)"
    exit 0
fi

# ライン カバレッジ % 抽出
CURRENT=$(node -e "
  const s = require('./${SUMMARY}');
  process.stdout.write(String(s.total.lines.pct));
" 2>/dev/null || echo "0")
echo "[2/3] 現在のカバレッジ: ${CURRENT}%"

# ── ベースライン設定モード ──
if $SET_BASELINE; then
    echo "$CURRENT" > "$BASELINE_FILE"
    echo "[3/3] ✅ ベースライン設定完了: ${CURRENT}%"
    echo "      git add $BASELINE_FILE を実行してコミットしてください"
    exit 0
fi

# ── ベースライン未設定の場合はスキップ ──
if [[ ! -f "$BASELINE_FILE" ]]; then
    echo "⚠️  ベースライン未設定です。"
    echo "   初回設定コマンド: bash SCRIPTS/gate-1.6-coverage-check.sh --set-baseline"
    echo "   現在のカバレッジ: ${CURRENT}% (今回はスキップ)"
    exit 0
fi

BASELINE=$(cat "$BASELINE_FILE")
echo "[3/3] ベースライン: ${BASELINE}%"

# 低下幅計算 (python3 使用)
DROP=$(python3 -c "
b = float('${BASELINE}')
c = float('${CURRENT}')
drop = b - c
print(f'{drop:.2f}')
" 2>/dev/null || echo "0")

# 合否判定
if python3 -c "exit(0 if float('${DROP}') <= ${MAX_DROP} else 1)"; then
    echo "✅ Gate 1.6 PASS: ${CURRENT}% (ベースライン: ${BASELINE}%, 低下: -${DROP}%)"
else
    echo "❌ Gate 1.6 FAIL: カバレッジ低下 ${DROP}% > 許容値 ${MAX_DROP}%"
    echo "   現在: ${CURRENT}%, ベースライン: ${BASELINE}%"
    echo "   テストを追加するか、--set-baseline でベースラインを更新してください"
    exit 1
fi
