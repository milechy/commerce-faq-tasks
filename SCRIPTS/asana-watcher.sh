#!/usr/bin/env bash
# asana-watcher.sh
# 用途: 24h 自走中に Asana から「自走可能な未完了タスク」を優先度順に取得し、JSON で stdout に出力する。
#       CLI（Claude Code）が自走プロンプト内でこのスクリプトを呼び、次タスクを補給する想定。
#
# 設計:
#   - Asana REST API を curl で直接叩く（Asana MCP の transient エラー時のフォールバック手段を兼ねる）
#   - Project: RAJIUCE Development (GID 1213607637045514) の incomplete タスクのみ
#   - フィルタ条件（docs/ASANA_TASK_TEMPLATE.md §24h-eligible タグ運用 準拠）:
#       * Tier B → 常に自走対象（タグ不要）
#       * Tier A + `24h-eligible` タグ (GID 1214922984195645) → 自走対象
#       * Tier S → 常に除外（タグがあっても無効）
#       * Tier 不明 → 安全側で除外
#       * description / name に DB migration キーワード → 除外（人間専権）
#   - 優先度: due_on asc (null は末尾) → Tier (A>B)
#
# 出力: JSON (stdout)
#   {
#     "generated_at": "...", "total_open": N, "eligible_count": N,
#     "tasks":   [ { gid, name, tier, due_on, permalink_url, tag_names, reason, notes_excerpt } ],
#     "skipped": [ { gid, name, reason } ]
#   }
#
# 環境変数（${R2C_CONFIG:-~/.claude-r2c-config}/secrets/r2c-loop.env から自動読込）:
#   ASANA_ACCESS_TOKEN  (必須)
#
# 呼び出し例:
#   bash SCRIPTS/asana-watcher.sh                   # 通常実行（JSON to stdout）
#   bash SCRIPTS/asana-watcher.sh --limit 5         # 上位 5 件のみ
#   bash SCRIPTS/asana-watcher.sh --verbose         # 進捗ログ stderr
#   bash SCRIPTS/asana-watcher.sh --dry-run         # API は叩くが処理サマリのみ stderr
#   bash SCRIPTS/asana-watcher.sh --mock-file F     # F を Asana API レスポンスとして使用（テスト用）
#
# 一切しないこと:
#   - Asana タスクの completed=true / description 書き換え
#   - DB migration 必要タスクの補給
#   - VPS 接続 / git push
#
# Phase70-D (Asana GID 1214919660548852)

set -euo pipefail

# ─── 定数 ──────────────────────────────────────────────────────────────────
ASANA_PROJECT_GID="${ASANA_PROJECT_GID:-1213607637045514}"
ELIGIBLE_TAG_GID="${ELIGIBLE_TAG_GID:-1214922984195645}"
R2C_CONFIG="${R2C_CONFIG:-${CLAUDE_CONFIG_DIR:-$HOME/.claude-r2c-config}}"
SECRETS_FILE="${R2C_CONFIG}/secrets/r2c-loop.env"
ASANA_API_BASE="https://app.asana.com/api/1.0"

# ─── 引数 ──────────────────────────────────────────────────────────────────
DRY_RUN=0
VERBOSE=0
LIMIT=0
MOCK_FILE=""

print_help() { sed -n '2,40p' "$0"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)    DRY_RUN=1; VERBOSE=1; shift ;;
        --verbose|-v) VERBOSE=1; shift ;;
        --limit)      LIMIT="${2:?--limit requires a number}"; shift 2 ;;
        --mock-file)  MOCK_FILE="${2:?--mock-file requires a path}"; shift 2 ;;
        -h|--help)    print_help; exit 0 ;;
        *) echo "ERROR: unknown arg: $1" >&2; print_help >&2; exit 2 ;;
    esac
done

log() { [ "$VERBOSE" -eq 1 ] && echo "[asana-watcher] $*" >&2 || true; }

# ─── 依存チェック ──────────────────────────────────────────────────────────
for cmd in curl jq; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "ERROR: required command not found: $cmd" >&2
        exit 3
    fi
done

# ─── 環境変数読込 ─────────────────────────────────────────────────────────
if [ -z "${ASANA_ACCESS_TOKEN:-}" ] && [ -f "$SECRETS_FILE" ]; then
    # shellcheck disable=SC1090
    source "$SECRETS_FILE"
fi

if [ -z "$MOCK_FILE" ] && [ -z "${ASANA_ACCESS_TOKEN:-}" ]; then
    echo "ERROR: ASANA_ACCESS_TOKEN not set. Place 'export ASANA_ACCESS_TOKEN=...' in ${SECRETS_FILE}" >&2
    exit 4
fi

# ─── 一時ファイル ──────────────────────────────────────────────────────────
RAW=$(mktemp)
trap 'rm -f "$RAW"' EXIT

# ─── Asana API 呼び出し（または mock 読込） ────────────────────────────────
if [ -n "$MOCK_FILE" ]; then
    if [ ! -f "$MOCK_FILE" ]; then
        echo "ERROR: mock file not found: $MOCK_FILE" >&2
        exit 5
    fi
    log "Using mock file: $MOCK_FILE"
    cp "$MOCK_FILE" "$RAW"
else
    OPT_FIELDS="gid,name,notes,due_on,completed,permalink_url,modified_at,tags.gid,tags.name"
    URL="${ASANA_API_BASE}/tasks?project=${ASANA_PROJECT_GID}&completed_since=now&opt_fields=${OPT_FIELDS}&limit=100"
    log "Fetching: $URL"

    HTTP_STATUS=$(curl -sS --max-time 25 -o "$RAW" -w "%{http_code}" \
        -H "Authorization: Bearer ${ASANA_ACCESS_TOKEN}" \
        -H "Accept: application/json" \
        "$URL" || echo "000")

    if [ "$HTTP_STATUS" != "200" ]; then
        echo "ERROR: Asana API returned HTTP ${HTTP_STATUS}" >&2
        head -c 500 "$RAW" >&2 2>/dev/null || true
        echo "" >&2
        # 失敗時も valid JSON を返す（CLI が parse できるように）
        jq -n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg err "asana_api_http_${HTTP_STATUS}" \
            '{generated_at:$ts, total_open:0, eligible_count:0, error:$err, tasks:[], skipped:[]}'
        exit 6
    fi
fi

# ─── jq parse 検証 (UATa asana-poll.sh の jq fix 教訓) ─────────────────────
if ! jq -e '.data' < "$RAW" >/dev/null 2>&1; then
    echo "ERROR: unexpected Asana response (first 500 bytes follow):" >&2
    head -c 500 "$RAW" >&2; echo "" >&2
    jq -n --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{generated_at:$ts, total_open:0, eligible_count:0, error:"asana_response_parse_failed", tasks:[], skipped:[]}'
    exit 7
fi

TOTAL_OPEN=$(jq '[.data[] | select(.completed == false)] | length' < "$RAW")
log "Open tasks fetched: ${TOTAL_OPEN}"

# ─── フィルタ・分類 (jq ワンショット) ──────────────────────────────────────
# Tier 抽出: description の "Tier: [SAB]" 行を優先、なければ title の "[Tier S|A|B]" レガシー記法
# DB migration 検出: name + notes に強キーワード（migration / alembic / マイグレーション /
#   ALTER TABLE / CREATE TABLE / DROP TABLE）または title 接頭辞 "schema:" を含む場合
#
# DB migration 用キーワードは false-positive を避けるため、
# 単独 "SQL" や "DB" のような弱キーワードは含めない（"NoSQL" や "DB 接続" を誤検出するため）。
CLASSIFIED=$(jq --arg eligible_tag "$ELIGIBLE_TAG_GID" '
    def excerpt(s; n): if (s|type)=="string" then s[0:n] else "" end;

    def detect_tier(name; notes):
        if (notes // "") | test("(^|\\n)\\s*Tier\\s*:\\s*S\\b"; "i") then "S"
        elif (notes // "") | test("(^|\\n)\\s*Tier\\s*:\\s*A\\b"; "i") then "A"
        elif (notes // "") | test("(^|\\n)\\s*Tier\\s*:\\s*B\\b"; "i") then "B"
        elif (name  // "") | test("\\[Tier\\s*S\\]"; "i") then "S"
        elif (name  // "") | test("\\[Tier\\s*A\\]"; "i") then "A"
        elif (name  // "") | test("\\[Tier\\s*B\\]"; "i") then "B"
        else "unknown"
        end;

    def db_migration_kw:
        "migration|alembic|\\bALTER\\s+TABLE\\b|\\bCREATE\\s+TABLE\\b|\\bDROP\\s+TABLE\\b|マイグレーション|DBスキーマ変更|DB\\s*スキーマ変更";

    def is_db_migration(name; notes):
        ((name  // "") | test(db_migration_kw; "i")) or
        ((notes // "") | test(db_migration_kw; "i")) or
        ((name  // "") | test("^\\s*schema\\s*:"; "i"));

    def has_eligible_tag(tags):
        (tags // []) | map(.gid) | index($eligible_tag) != null;

    [ .data[] | select(.completed == false) ] as $open
    | $open
    | map(
        . as $t
        | (detect_tier($t.name; $t.notes)) as $tier
        | (has_eligible_tag($t.tags)) as $has_tag
        | (is_db_migration($t.name; $t.notes)) as $is_mig
        | (
            if   $is_mig            then {eligible:false, reason:"db_migration"}
            elif $tier == "S"       then {eligible:false, reason:"tier_s"}
            elif $tier == "B"       then {eligible:true,  reason:"tier_b"}
            elif $tier == "A" and $has_tag then {eligible:true, reason:"tier_a_with_tag"}
            elif $tier == "A"       then {eligible:false, reason:"tier_a_no_tag"}
            else                         {eligible:false, reason:"tier_unknown"}
            end
          ) as $cls
        | {
            gid:           $t.gid,
            name:          ($t.name // ""),
            tier:          $tier,
            due_on:        ($t.due_on // null),
            permalink_url: ($t.permalink_url // ""),
            modified_at:   ($t.modified_at // null),
            tag_names:     ((($t.tags // []) | map(.name))),
            has_eligible_tag: $has_tag,
            notes_excerpt: excerpt(($t.notes // ""); 200),
            eligible:      $cls.eligible,
            reason:        $cls.reason
          }
      )
' < "$RAW")

# ─── 並び替え（eligible のみ）+ skipped 抽出 ───────────────────────────────
# 優先度: due_on asc (null 末尾) → Tier (A>B) → modified_at desc
ELIGIBLE_SORTED=$(jq '
    [ .[] | select(.eligible == true) ]
    | sort_by(
        (if .due_on == null or .due_on == "" then "9999-12-31" else .due_on end),
        (if .tier == "A" then 0 elif .tier == "B" then 1 else 9 end),
        (if .modified_at == null then "" else (-(.modified_at|fromdateiso8601? // 0)) end)
      )
    | map(del(.eligible))
' <<< "$CLASSIFIED")

SKIPPED=$(jq '
    [ .[] | select(.eligible == false) | {gid, name, tier, reason} ]
' <<< "$CLASSIFIED")

# ─── --limit 適用 ──────────────────────────────────────────────────────────
if [ "$LIMIT" -gt 0 ]; then
    ELIGIBLE_SORTED=$(jq --argjson n "$LIMIT" '.[0:$n]' <<< "$ELIGIBLE_SORTED")
fi

ELIGIBLE_COUNT=$(jq 'length' <<< "$ELIGIBLE_SORTED")
SKIPPED_COUNT=$(jq 'length' <<< "$SKIPPED")
log "Eligible: ${ELIGIBLE_COUNT} / Skipped: ${SKIPPED_COUNT} (limit=${LIMIT})"

# ─── 出力 ──────────────────────────────────────────────────────────────────
if [ "$DRY_RUN" -eq 1 ]; then
    {
        echo "DRY-RUN summary:"
        echo "  total_open    = ${TOTAL_OPEN}"
        echo "  eligible      = ${ELIGIBLE_COUNT}"
        echo "  skipped       = ${SKIPPED_COUNT}"
        echo "Eligible top 5 (gid | tier | due | name):"
        jq -r '.[0:5][] | "  \(.gid) | \(.tier) | \(.due_on // "—") | \(.name)"' <<< "$ELIGIBLE_SORTED"
        echo "Skipped reasons:"
        jq -r 'group_by(.reason) | map({reason: .[0].reason, count: length}) | .[] | "  \(.reason): \(.count)"' <<< "$SKIPPED"
    } >&2
fi

jq -n \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson total "$TOTAL_OPEN" \
    --argjson elig_count "$ELIGIBLE_COUNT" \
    --argjson tasks "$ELIGIBLE_SORTED" \
    --argjson skipped "$SKIPPED" \
    '{
        generated_at: $ts,
        project_gid:  "'"$ASANA_PROJECT_GID"'",
        eligible_tag_gid: "'"$ELIGIBLE_TAG_GID"'",
        total_open:     $total,
        eligible_count: $elig_count,
        tasks:          $tasks,
        skipped:        $skipped
    }'
