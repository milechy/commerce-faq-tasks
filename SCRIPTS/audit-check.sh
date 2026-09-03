#!/bin/bash
# SCRIPTS/audit-check.sh
#
# pnpm audit を実行し、結果を3状態に分類する唯一の実装。
#
# ■ なぜ分けるのか（2026-09-04 是正・Asana 1218165546985984）
# pnpm audit は「脆弱性を検出した」ときも「レジストリに到達できなかった」ときも
# 同じように非ゼロ終了する。従来はどちらも
#   [HIGH] pnpm audit detected high/critical vulnerabilities
# と報告していたため、npm の audit エンドポイントが不通になるたびに
# 無関係な PR のマージがブロックされていた(#1157 で実際に発生。
# ★ローカルでも同じ ERR_SOCKET_TIMEOUT を再現したので CI 固有ではない★)。
#
# 本当の害は足止めそのものより「FAIL の意味が薄まること」にある。
# 本物かネットワークかを見分けられない警告は、いずれ全部無視されるようになる。
#
# ■ 分類
#   clean       … 到達できて、閾値以上の脆弱性なし          → exit 0
#   not_checked … 到達できなかった(検査していない)          → exit 0（★ただし WARN を出す★）
#   vulnerable  … 到達できて、閾値以上の脆弱性あり          → exit 1
#
# ■ ★判別できないときは vulnerable に倒す（fail-closed）★
# ネットワーク由来と断定できる痕跡が無い非ゼロ終了は、脆弱性として扱う。
# 「分からないから通す」は、この種のゲートで最もやってはいけない倒し方。
#
# ■ not_checked を黙って PASS にしない
# 呼び出し元が集計できるよう、必ず AUDIT_STATUS= 行を1行出す。
# 検査できていない期間が常態化したら気づけるようにするため。
#
# Usage: bash SCRIPTS/audit-check.sh
# Output: 監査の生出力 + 最終行に AUDIT_STATUS=clean|not_checked|vulnerable

set -o pipefail

AUDIT_OUT=$(pnpm audit --production --audit-level=high 2>&1)
AUDIT_RC=$?

echo "$AUDIT_OUT"

if [[ $AUDIT_RC -eq 0 ]]; then
  echo 'AUDIT_STATUS=clean'
  exit 0
fi

# レジストリへ到達できなかったことを示す痕跡。
# pnpm/npm/node がネットワーク失敗時に出す代表的な文字列に限定する。
NETWORK_MARKERS='ERR_SOCKET_TIMEOUT|FetchError|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|socket hang up|network timeout|ERR_PNPM_META_FETCH_FAIL|registry returned 5[0-9][0-9]|Socket timeout'

# 実際に advisory が返ってきたことを示す痕跡。
# ネットワーク痕跡と同時に出ている場合は「一部は取得できた」= 検査結果として扱う。
ADVISORY_MARKERS='vulnerabilities? found|advisories|Severity:|┌|│ high|│ critical'

if echo "$AUDIT_OUT" | grep -qE "$NETWORK_MARKERS" && ! echo "$AUDIT_OUT" | grep -qE "$ADVISORY_MARKERS"; then
  echo ''
  echo "[WARN] pnpm audit を実行できませんでした（レジストリへ到達不可, exit=${AUDIT_RC}）。"
  echo '       ★脆弱性が無いことを確認できたわけではありません★'
  echo '       依存を変更する PR では、到達可能になってから再実行して確認すること。'
  echo 'AUDIT_STATUS=not_checked'
  exit 0
fi

echo ''
echo "[HIGH] pnpm audit が閾値(high)以上の脆弱性を検出しました (exit=${AUDIT_RC})"
echo 'AUDIT_STATUS=vulnerable'
exit 1
