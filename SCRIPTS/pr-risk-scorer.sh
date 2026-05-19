#!/usr/bin/env bash
# pr-risk-scorer.sh — Phase70-F
#
# PR diff からリスクレベル(low/medium/high)を判定し、GitHub ラベルを付与する。
# 朝の人間レビュー(docs/MORNING_REVIEW_FLOW.md)で「何から見るか」を即座に判断可能にする。
#
# 判定基準:
#   low    = docs/*, *.md, tests/*, *.test.ts のみ変更
#   medium = src/ 単一機能変更, admin-ui/ 表示調整, 差分 ≤ 200 行
#   high   = src/middleware/, src/api/auth*, DB schema関連, security-scan.sh,
#            deploy*, .env*, .claude/hooks/, 複数 module 跨ぎ, 差分 > 200 行 + 本番影響
#
# 出力:
#   stdout: JSON { risk, reason, affected_paths, auto_merge_eligible, diff_stats }
#   GitHub: risk:low / risk:medium / risk:high ラベルを PR に付与
#   PR comment: リスク判定結果をコメント投稿(--no-comment で抑制)
#
# 使い方:
#   bash SCRIPTS/pr-risk-scorer.sh <PR番号>
#   bash SCRIPTS/pr-risk-scorer.sh <PR番号> --dry-run      # ラベル付与・コメント投稿なし
#   bash SCRIPTS/pr-risk-scorer.sh <PR番号> --no-comment   # コメント投稿なし(ラベルは付与)
#   bash SCRIPTS/pr-risk-scorer.sh <PR番号> --json-only    # JSON のみ stdout (ラベル・コメントなし)
#   bash SCRIPTS/pr-risk-scorer.sh --self-test             # 過去 PR サンプルで動作確認
#
# 環境変数:
#   GITHUB_TOKEN (gh CLI が使うもの、通常は gh auth login 済みで不要)
#   PR_RISK_NO_LABEL=1  ラベル付与をスキップ
#   PR_RISK_NO_COMMENT=1 コメント投稿をスキップ
#
# 依存: gh CLI, jq
#
# Asana: Phase70-F (GID 1214919682795187)
# 連携: morning-digest.sh (Phase70-C), Mergify (Phase70-I インターフェース合意済み)

set -euo pipefail

SCRIPT_NAME="$(basename "$0" .sh)"
R2C_ROOT="${R2C_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# ─── 引数 ──────────────────────────────────────────────────────────────────
PR_NUMBER=""
DRY_RUN=0
NO_COMMENT=0
JSON_ONLY=0
SELF_TEST=0
VERBOSE=0

usage() {
    cat <<EOF
Usage: $SCRIPT_NAME <PR番号> [--dry-run] [--no-comment] [--json-only] [-v]
       $SCRIPT_NAME --self-test

Options:
  --dry-run      ラベル付与・コメント投稿を行わない(判定のみ)
  --no-comment   コメント投稿なし(ラベルは付与)
  --json-only    JSON のみ stdout(ラベル・コメントなし)
  --self-test    過去 PR サンプルで動作確認
  -v, --verbose  詳細ログを stderr に出力
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)    DRY_RUN=1; shift ;;
        --no-comment) NO_COMMENT=1; shift ;;
        --json-only)  JSON_ONLY=1; DRY_RUN=1; shift ;;
        --self-test)  SELF_TEST=1; shift ;;
        -v|--verbose) VERBOSE=1; shift ;;
        -h|--help)    usage ;;
        [0-9]*)       PR_NUMBER="$1"; shift ;;
        *)            echo "ERROR: unknown arg: $1" >&2; usage; exit 1 ;;
    esac
done

log() { [[ "$VERBOSE" -eq 1 ]] && printf '[%s][%s] %s\n' "$(date '+%H:%M:%S')" "$SCRIPT_NAME" "$*" >&2 || true; }
err() { printf '[%s][%s] ERROR: %s\n' "$(date '+%H:%M:%S')" "$SCRIPT_NAME" "$*" >&2; }

# ─── 依存チェック ──────────────────────────────────────────────────────────
for cmd in gh jq; do
    command -v "$cmd" >/dev/null 2>&1 || { err "required command not found: $cmd"; exit 1; }
done

# ─── セルフテスト ──────────────────────────────────────────────────────────
if [[ "$SELF_TEST" -eq 1 ]]; then
    bash "${BASH_SOURCE[0]%.sh}.test.sh" 2>&1
    exit $?
fi

[[ -z "$PR_NUMBER" ]] && { err "PR番号を指定してください"; usage; exit 1; }

# ─── PR 情報取得 ───────────────────────────────────────────────────────────
log "Fetching PR #$PR_NUMBER info..."

PR_META="$(gh pr view "$PR_NUMBER" \
    --json number,title,headRefName,additions,deletions,labels,files \
    2>/dev/null)" || { err "PR #$PR_NUMBER が見つかりません"; exit 1; }

PR_TITLE="$(echo "$PR_META" | jq -r '.title')"
PR_BRANCH="$(echo "$PR_META" | jq -r '.headRefName')"
ADDITIONS="$(echo "$PR_META" | jq -r '.additions')"
DELETIONS="$(echo "$PR_META" | jq -r '.deletions')"
TOTAL_DIFF=$(( ADDITIONS + DELETIONS ))

# 変更ファイル一覧(パスのみ)
CHANGED_FILES="$(echo "$PR_META" | jq -r '.files[].path')"

log "PR #$PR_NUMBER: '$PR_TITLE' (+$ADDITIONS/-$DELETIONS, $(echo "$CHANGED_FILES" | wc -l | tr -d ' ') files)"

# ─── リスク判定ロジック ────────────────────────────────────────────────────
# 判定は「high パスに 1 件でも該当 → high」、
# 「medium パスに 1 件でも該当 → medium」、
# 「それ以外全て low/safe パスのみ → low」の優先順位で行う。

RISK_REASONS=()
AFFECTED_HIGH=()
AFFECTED_MEDIUM=()
AFFECTED_LOW=()

# ── high リスクパターン ────────────────────────────────────────────────────
HIGH_PATTERNS=(
    # セキュリティ・認証
    "^src/middleware/"
    "^src/api/auth"
    "^src/agent/security"
    # DB/スキーマ
    "migration"
    "\.sql$"
    "schema"
    # デプロイ・設定
    "^SCRIPTS/deploy"
    "^SCRIPTS/security-scan"
    "^SCRIPTS/24h-mode"
    "^\.env"
    # セーフガード(自己編集禁止)
    "^\.claude/hooks/"
    # GitHub Actions (CI 改変)
    "^\.github/workflows/"
)

# ── medium リスクパターン (high に該当しない場合) ──────────────────────────
MEDIUM_PATTERNS=(
    "^src/"
    "^admin-ui/src/"
    "^admin-ui/.*\.(ts|tsx|js|jsx)$"
    "^SCRIPTS/"
    "^\.claude/"
    "package\.json$"
    "pnpm-lock\.yaml$"
    "tsconfig"
    "vite\.config"
    "ecosystem\.config"
)

# ── low リスクパターン(全ファイルがこれだけなら low) ──────────────────────
LOW_PATTERNS=(
    "^docs/"
    "\.md$"
    "^tests/"
    "\.test\.(ts|tsx|js)$"
    "^\.wolf/"
    "^DAILY_REPORT"
)

classify_file() {
    local f="$1"
    # high チェック(最優先)
    for pat in "${HIGH_PATTERNS[@]}"; do
        if echo "$f" | grep -qE "$pat"; then
            echo "high"
            return
        fi
    done
    # .claude/(hooks 以外)は設定ファイルのため medium(.md でも上書き)
    if echo "$f" | grep -qE "^\.claude/" && ! echo "$f" | grep -qE "^\.claude/hooks/"; then
        echo "medium"
        return
    fi
    # low パターンを先にチェック(test ファイルが src/ 配下でも low にする)
    for pat in "${LOW_PATTERNS[@]}"; do
        if echo "$f" | grep -qE "$pat"; then
            echo "low"
            return
        fi
    done
    # medium チェック
    for pat in "${MEDIUM_PATTERNS[@]}"; do
        if echo "$f" | grep -qE "$pat"; then
            echo "medium"
            return
        fi
    done
    # デフォルト low
    echo "low"
}

HAS_HIGH=0
HAS_MEDIUM=0

while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    cls="$(classify_file "$file")"
    case "$cls" in
        high)
            AFFECTED_HIGH+=("$file")
            HAS_HIGH=1
            ;;
        medium)
            AFFECTED_MEDIUM+=("$file")
            HAS_MEDIUM=1
            ;;
        *)
            AFFECTED_LOW+=("$file")
            ;;
    esac
done <<< "$CHANGED_FILES"

# ── 最終リスク決定 ─────────────────────────────────────────────────────────
RISK="low"
AUTO_MERGE=true

if [[ "$HAS_HIGH" -eq 1 ]]; then
    RISK="high"
    AUTO_MERGE=false
    for f in "${AFFECTED_HIGH[@]}"; do
        RISK_REASONS+=("high-risk path: $f")
    done
elif [[ "$HAS_MEDIUM" -eq 1 ]]; then
    RISK="medium"
    AUTO_MERGE=false
    # diff 行数で更に判定
    if [[ "$TOTAL_DIFF" -gt 200 ]]; then
        RISK="high"
        AUTO_MERGE=false
        RISK_REASONS+=("large diff: +${ADDITIONS}/-${DELETIONS} (${TOTAL_DIFF} lines)")
    fi
    for f in "${AFFECTED_MEDIUM[@]}"; do
        RISK_REASONS+=("medium-risk path: $f")
    done
else
    # low のみ
    RISK="low"
    AUTO_MERGE=true
    RISK_REASONS+=("docs/tests/md only")
fi

# low でも diff が極端に大きければ medium に昇格
if [[ "$RISK" == "low" ]] && [[ "$TOTAL_DIFF" -gt 500 ]]; then
    RISK="medium"
    AUTO_MERGE=false
    RISK_REASONS+=("large diff even in docs: +${ADDITIONS}/-${DELETIONS}")
fi

log "Risk: $RISK | auto_merge_eligible: $AUTO_MERGE"

# ─── JSON 組み立て ─────────────────────────────────────────────────────────
REASON_JSON="$(printf '%s\n' "${RISK_REASONS[@]}" | jq -R . | jq -s .)"
HIGH_JSON="$(printf '%s\n' "${AFFECTED_HIGH[@]+"${AFFECTED_HIGH[@]}"}" | jq -R . | jq -s .)"
MEDIUM_JSON="$(printf '%s\n' "${AFFECTED_MEDIUM[@]+"${AFFECTED_MEDIUM[@]}"}" | jq -R . | jq -s .)"
LOW_JSON="$(printf '%s\n' "${AFFECTED_LOW[@]+"${AFFECTED_LOW[@]}"}" | jq -R . | jq -s .)"

OUTPUT_JSON="$(jq -n \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson pr_number "$PR_NUMBER" \
    --arg pr_title "$PR_TITLE" \
    --arg pr_branch "$PR_BRANCH" \
    --arg risk "$RISK" \
    --argjson reason "$REASON_JSON" \
    --argjson high_paths "$HIGH_JSON" \
    --argjson medium_paths "$MEDIUM_JSON" \
    --argjson low_paths "$LOW_JSON" \
    --argjson auto_merge "$AUTO_MERGE" \
    --argjson additions "$ADDITIONS" \
    --argjson deletions "$DELETIONS" \
    --argjson total_diff "$TOTAL_DIFF" \
    '{
        scored_at:           $ts,
        pr_number:           $pr_number,
        pr_title:            $pr_title,
        pr_branch:           $pr_branch,
        risk:                $risk,
        reason:              $reason,
        affected_paths: {
            high:   $high_paths,
            medium: $medium_paths,
            low:    $low_paths
        },
        auto_merge_eligible: $auto_merge,
        diff_stats: {
            additions: $additions,
            deletions: $deletions,
            total:     $total_diff
        },
        scorer_version: "1.0.0",
        scorer_script:  "SCRIPTS/pr-risk-scorer.sh"
    }')"

# JSON を stdout に出力
echo "$OUTPUT_JSON"

# json-only モードはここで終了
[[ "$JSON_ONLY" -eq 1 ]] && exit 0

# ─── GitHub ラベル付与 ─────────────────────────────────────────────────────
LABEL="risk:${RISK}"
REMOVE_LABELS=()
case "$RISK" in
    low)    REMOVE_LABELS=("risk:medium" "risk:high") ;;
    medium) REMOVE_LABELS=("risk:low"    "risk:high") ;;
    high)   REMOVE_LABELS=("risk:low"    "risk:medium") ;;
esac

if [[ "$DRY_RUN" -eq 0 ]] && [[ "${PR_RISK_NO_LABEL:-0}" -ne 1 ]]; then
    log "Applying label: $LABEL to PR #$PR_NUMBER"

    # ラベルが存在しない場合は自動作成
    for lbl in "risk:low" "risk:medium" "risk:high"; do
        if ! gh label list --json name -q '.[].name' 2>/dev/null | grep -q "^${lbl}$"; then
            case "$lbl" in
                "risk:low")    COLOR="0e8a16" ;;
                "risk:medium") COLOR="e6b800" ;;
                "risk:high")   COLOR="d93f0b" ;;
            esac
            gh label create "$lbl" --color "$COLOR" --description "Risk Scorer: $lbl" 2>/dev/null || true
            log "Created label: $lbl"
        fi
    done

    gh pr edit "$PR_NUMBER" --add-label "$LABEL" 2>/dev/null || \
        log "WARN: Failed to add label $LABEL"

    # 旧ラベルを除去
    for old_lbl in "${REMOVE_LABELS[@]}"; do
        if echo "$PR_META" | jq -r '.labels[].name' | grep -q "^${old_lbl}$"; then
            gh pr edit "$PR_NUMBER" --remove-label "$old_lbl" 2>/dev/null || true
            log "Removed old label: $old_lbl"
        fi
    done
else
    log "[DRY-RUN] Would apply label: $LABEL"
fi

# ─── PR コメント投稿 ───────────────────────────────────────────────────────
risk_emoji() {
    case "$1" in
        low)    echo "🟢" ;;
        medium) echo "🟡" ;;
        high)   echo "🔴" ;;
        *)      echo "⚪" ;;
    esac
}

EMOJI="$(risk_emoji "$RISK")"
AUTO_MERGE_TEXT="$([ "$AUTO_MERGE" = "true" ] && echo "✅ auto-merge 候補" || echo "❌ 人間レビュー必要")"

REASON_TEXT="$(printf '%s\n' "${RISK_REASONS[@]}" | head -5 | sed 's/^/- /')"
[[ ${#AFFECTED_HIGH[@]} -gt 0 ]] && HIGH_TEXT="$(printf '%s\n' "${AFFECTED_HIGH[@]}" | head -5 | sed 's/^/  - /')" || HIGH_TEXT="(なし)"
[[ ${#AFFECTED_MEDIUM[@]} -gt 0 ]] && MEDIUM_TEXT="$(printf '%s\n' "${AFFECTED_MEDIUM[@]}" | head -5 | sed 's/^/  - /')" || MEDIUM_TEXT="(なし)"

COMMENT_BODY="## ${EMOJI} Risk Scorer 判定 (Phase70-F)

**リスクレベル: \`${RISK}\`** ${EMOJI} | ${AUTO_MERGE_TEXT}

### 判定根拠
${REASON_TEXT}

### 影響パス
**high リスクパス:**
${HIGH_TEXT}

**medium リスクパス (上位5件):**
${MEDIUM_TEXT}

### diff 統計
- 追加行: +${ADDITIONS}
- 削除行: -${DELETIONS}
- 合計: ${TOTAL_DIFF} 行

### 参照
- 判定基準: \`docs/MORNING_REVIEW_FLOW.md §3. 判定マトリクス\`
- スクリプト: \`SCRIPTS/pr-risk-scorer.sh\`
- JSON 出力: \`bash SCRIPTS/pr-risk-scorer.sh ${PR_NUMBER} --json-only\`

> 自動判定 by Phase70-F Risk Scorer v1.0.0 | $(date '+%Y-%m-%d %H:%M JST')"

if [[ "$DRY_RUN" -eq 0 ]] && [[ "$NO_COMMENT" -eq 0 ]] && [[ "${PR_RISK_NO_COMMENT:-0}" -ne 1 ]]; then
    log "Posting comment to PR #$PR_NUMBER..."
    gh pr comment "$PR_NUMBER" --body "$COMMENT_BODY" 2>/dev/null || \
        log "WARN: Failed to post comment"
else
    log "[DRY-RUN/NO-COMMENT] Would post comment to PR #$PR_NUMBER"
fi

log "Done. PR #$PR_NUMBER risk=$RISK auto_merge_eligible=$AUTO_MERGE"
