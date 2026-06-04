# 調査報告: Tier-S id=4 running固着 + single-slotブロッキング + rollback誤判定

**調査日**: 2026-05-29  
**Asana タスク GID**: 1215236154458123 (Lane 53)  
**対象タスク**: id=4 ([Tier S] prod_change: R2C 24h自律ループ導入)  

---

## TL;DR

3 件の独立したバグが重なり、Tier-S id=4 が running 固着する。

| # | バグ | スクリプト | 影響 |
|---|---|---|---|
| **B1** | `IFS='\|'` split が asana_notes 内の `\|` で崩壊 | r2c-generate-lane.sh | **全タスクで TIER/TASK_TYPE が空** → 常に tier-b-docs.md フォールバック |
| **B2** | `changes()` を別接続で呼ぶため常に 0 表示 | r2c-queue-update.sh | セッションは正常書込み済みなのに "updated rows≈0" と誤ログ |
| **B3** | plan モード session が supervisor kill 後も zombie 残存 | r2c-supervisor.sh | 旧 session が `waiting` のまま claude agents に表示 |

**B1 が最重要**: Tier-S タスクが Tier-B テンプレで dispatch されるため、plan モードで docs 作業を試みてタスク完了せず 45分 stuck → rollback コースが確定する。

---

## 調査ログ

### 1. DB 現状確認

```
id=4  tier=S  state=running  session_id=002d25a9  attempt_count=2  started_at=2026-05-29 01:27:34
```

- `attempt_count=2` → 既に 1 回 supervisor retry 済み  
- `max_attempts=3` → 次の stuck 検出 (01:27 + 45min = 02:12 UTC) でrollback確定

### 2. claude agents の状態

```json
{ "name": "auto-s-4", "sessionId": "002d25a9...", "status": "busy" }    ← 第2試行 (DB記録)
{ "name": "auto-s-4", "sessionId": "92213cb6...", "status": "waiting" } ← 第1試行の zombie
```

同名 `auto-s-4` が 2 セッション存在。`waiting` 状態の zombie は supervisor の pkill 後も残存。

### 3. r2c-generate-lane.sh ログ (Bug B1 の証拠)

```
[2026-05-29_09:41:18] === r2c-generate-lane start (task=4 dry=0) ===
WARNING: no template match for tier= type=, fallback to tier-b-docs.md
Template: .../tier-b-docs.md
Branch:   auto/-4-tier-s-prod-change-r2c-24h-uata
          ^^^^^ tier が空 (本来は "s")

[2026-05-29_10:27:32] === r2c-generate-lane start (task=4 dry=0) ===
WARNING: no template match for tier= type=, fallback to tier-b-docs.md
Template: .../tier-b-docs.md
Branch:   auto/-4-tier-s-prod-change-r2c-24h-uata
```

両試行とも `tier=` `type=` が空文字列。tier-s-prod.md は一度も使われていない。

### 4. Bug B1 根本原因: IFS='|' split

`r2c-generate-lane.sh` の問題箇所 (L72前後):

```bash
TASK_DATA=$(SQ "SELECT asana_gid, asana_name, asana_notes, asana_permalink, asana_due_on, tier, task_type, model FROM tasks WHERE id = ${TASK_ID};")
IFS='|' read -r ASANA_GID ASANA_NAME ASANA_NOTES ASANA_PERMALINK ASANA_DUE_ON TIER TASK_TYPE MODEL <<< "$TASK_DATA"
```

`sqlite3` のデフォルト出力セパレータは `|`。`asana_notes` がマークダウンテーブル (`| 列 | 列 |` 形式) や pipe 文字を含む場合、`IFS='|' read` が余分な位置でスプリットし、**TIER 以降のフィールドが前方にズレる**。

task=4 の asana_notes には `## 目的` 以下にマークダウン内容が含まれており、pipe 文字で崩壊。結果として `TIER=""` `TASK_TYPE=""` となり case 文の `"S:"*` にマッチしない。

**影響範囲**: asana_notes に `|` を含む全タスク。generate-lane ログを確認すると task=48, 49 等も同じ `WARNING: no template match for tier= type=` が出ており、全て Tier-B フォールバック。

### 5. Bug B2: changes() 別接続問題

```bash
# r2c-queue-update.sh の実装 (問題箇所)
{
    echo "BEGIN;"
    echo "$UPDATE_SQL"
    echo "COMMIT;"
} | sqlite3 "$QUEUE_DB"           # ← 接続 A でトランザクション実行

CHANGED=$(sqlite3 "$QUEUE_DB" \
    "SELECT changes();" ...)      # ← 接続 B で changes() → 常に 0
```

SQLite の `changes()` は**同一接続の最後の変更行数**を返す。別接続では常に 0。

**実証**:
```bash
# 別接続 → 0
sqlite3 "$QUEUE_DB" "UPDATE tasks SET updated_at=updated_at WHERE id=4;"
sqlite3 "$QUEUE_DB" "SELECT changes();"  # → 0

# 同一接続 → 1
sqlite3 "$QUEUE_DB" "UPDATE tasks SET updated_at=updated_at WHERE id=4; SELECT changes();"  # → 1
```

supervisor ログで `session=92213cb6` が確認できるため、session_id は正常に DB へ書き込まれていた。"session未アタッチのままrunning固着" という認識は B2 の誤ログに起因する誤認識。

### 6. Bug B3: zombie session 残存

supervisor の kill 処理:

```bash
if [ -n "$SID" ]; then
    pkill -f "claude.*${SID}" 2>/dev/null || true
fi
```

`pkill` はラッパーシェルプロセスを kill するが、claude の plan モード session (`waiting` 状態) はプロセスではなく Claude Code 内部の状態として残る。`claude agents` には引き続き表示され、スロットを視覚的に汚染する (実際の MAX_SLOTS カウントには影響しない — DB の state で管理)。

### 7. Tier-S single-slot ブロッキングの全体像

```
dispatch.sh:
  tier=S → perm_mode="plan"  (dispatch.sh L120 case文より)
  + generate-lane.sh → tier-b-docs.md テンプレ (B1)

claude --bg 起動:
  plan モードで Tier-B docs 作業を試みる
  → plan 提示後、承認待ち (waiting)
  → headless = 承認者不在 → 永久 stuck

supervisor (45分後):
  stuck 検出 → session_id=NULL, state=pending → retry
  → worktree 削除 → git fetch + worktree add (~ 3分) → 再 dispatch
  → 同じ挙動を繰り返す

3回目 (attempt=3) で rollback → "rollbacked" 状態へ誤判定
```

---

## 修正方針

### Fix-1 (必須, 高優先): r2c-generate-lane.sh — sqlite3 セパレータを変更

```bash
# 現行 (問題)
TASK_DATA=$(SQ "SELECT asana_gid, asana_name, asana_notes, ... FROM tasks WHERE id = ${TASK_ID};")
IFS='|' read -r ASANA_GID ASANA_NAME ASANA_NOTES ... TIER TASK_TYPE MODEL <<< "$TASK_DATA"

# 修正案1: sqlite3 -separator を ASCII 31 (Unit Separator) に変更
TASK_DATA=$(sqlite3 "$QUEUE_DB" -separator $'\x1f' \
    "SELECT asana_gid, asana_name, asana_notes, asana_permalink, asana_due_on, tier, task_type, model FROM tasks WHERE id = ${TASK_ID};")
IFS=$'\x1f' read -r ASANA_GID ASANA_NAME ASANA_NOTES ASANA_PERMALINK ASANA_DUE_ON TIER TASK_TYPE MODEL <<< "$TASK_DATA"

# 修正案2: 各フィールドを個別クエリで取得 (確実だが SQL 呼出し増)
TIER=$(SQ "SELECT tier FROM tasks WHERE id = ${TASK_ID};")
TASK_TYPE=$(SQ "SELECT task_type FROM tasks WHERE id = ${TASK_ID};")
ASANA_NOTES=$(SQ "SELECT asana_notes FROM tasks WHERE id = ${TASK_ID};")
# etc.
```

推奨: **修正案1** (ASCII 31 は notes に含まれない制御文字)。1 行変更で全フィールドの崩壊を防止。

### Fix-2 (中優先): r2c-queue-update.sh — changes() を同一接続内で実行

```bash
# 修正: transaction 内で changes() を取得
RESULT=$(
    {
        printf '%s\n' "BEGIN;"
        printf '%s\n' "$UPDATE_SQL"
        [ -n "$EVENT_SQL" ] && printf '%s\n' "$EVENT_SQL"
        printf '%s\n' "SELECT changes();"
        printf '%s\n' "COMMIT;"
    } | sqlite3 "$QUEUE_DB"
)
CHANGED=$(echo "$RESULT" | tail -1)
log "  updated rows≈$CHANGED"
```

### Fix-3 (低優先): r2c-supervisor.sh — Tier-S は rollback せず needs_approval へ遷移

```bash
# 修正: Tier-S の rollback を needs_approval に変更
if [ "$ATTEMPT_NUM" -lt "$MAX_ATTEMPTS" ]; then
    SQ "UPDATE tasks SET state='pending', ... WHERE id = ${TID};"
else
    # Tier-S は人間承認が必要なため rollback ではなく needs_approval へ
    TASK_TIER=$(SQ "SELECT tier FROM tasks WHERE id = ${TID};")
    if [ "${TASK_TIER}" = "S" ]; then
        SQ "UPDATE tasks SET state='needs_approval', error_message='Tier-S requires human intervention', last_action='escalated_to_human' WHERE id = ${TID};"
        notify 1 "R2C Tier-S needs human" "Task ${TID} (Tier-S) stuck ${MAX_ATTEMPTS}x. Manual review required: ${NAME}"
    else
        SQ "UPDATE tasks SET state='rollbacked', ... WHERE id = ${TID};"
        notify 1 "R2C Lane FAILED (rollback)" "..."
    fi
fi
```

### Fix-4 (補足): zombie session の定期クリーンアップ

`claude agents stop <session_id>` を supervisor の cleanup に追加して waiting zombie を除去する。

---

## 緊急対応 (今すぐ実行可能)

task=4 の次の rollback を防ぐためには、hkobayashi が手動で以下を実行:

```bash
# オプション A: 今すぐ needs_approval に昇格 (supervisor の rollback を防ぐ)
sqlite3 ~/.../r2c-queue.db \
  "UPDATE tasks SET state='needs_approval', error_message='Tier-S plan mode: human approval required', last_action='manual_escalate' WHERE id=4;"

# オプション B: キャンセル (今回は Tier-S タスクを手動対応する)
sqlite3 ~/.../r2c-queue.db \
  "UPDATE tasks SET state='cancelled', error_message='Tier-S cannot auto-run in headless mode', last_action='manual_cancel' WHERE id=4;"
```

Fix-1 (generate-lane.sh の IFS バグ修正) が入るまでは、Tier-A/S タスクも同様に全て誤ったテンプレで dispatch されるため、手動対応が必要。

---

## 教訓 (CLAUDE.md / MEMORY.md 反映候補)

1. **sqlite3 pipe separator は notes フィールドに使えない** — `IFS='|'` split + sqlite3 デフォルト出力の組み合わせは notes/name に `|` が含まれた瞬間に崩壊する。ASCII 31 (Unit Separator) を使うこと。
2. **Tier-S は headless dispatch 不可** — plan モードは承認者が居る状態でのみ起動可能。自動 dispatch サイクルからは Tier-S を除外するか、`needs_approval` 遷移に切り替える。
3. **`changes()` は同一接続内で呼ぶ** — 別接続では常に 0。ログの "updated rows≈0" は信用しない。
4. **zombie session の識別方法** — `claude agents --json | jq '.[] | select(.status=="waiting")'` で headless plan-mode session を識別できる。

---

## Gate チェック

```
## Gate 1: pnpm verify
- typecheck: N/A (docs only)
- lint: N/A (docs only)
- test: N/A (docs only)

## Gate 1.5: dead-code-check
- N/A (新規コードファイル無し)

## Gate 2: security-scan
- High/Critical: N/A (docs only)
- 機密情報目視確認: API key / token / IP 混入なし ✓

## Gate 3: build
- pnpm build: N/A (docs only)
- admin-ui build: N/A (docs only)
```
