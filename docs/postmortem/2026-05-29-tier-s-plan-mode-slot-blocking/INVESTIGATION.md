# 調査レポート: Tier-S id=4 running固着 + single-slot ブロッキング + rollback誤判定疑い

- **発生日**: 2026-05-29
- **調査 Lane**: auto/b-53-24h-tier-s-id-4-session-running-single-s
- **Asana GID (調査タスク)**: 1215236154458123
- **関連タスク (Tier-S id=4)**: GID 1214893855764119

---

## 1. 調査対象の症状

Asana タスクタイトル:
> 24hループ Tier-S id=4 が session未アタッチのままrunning固着 + single-slotブロッキング / rollback誤判定疑い

疑われた現象:
1. Tier-S task (id=4) が `session_id` 未設定のまま `state=running` に固着
2. このタスクが 1 slot を永続占有し、新規タスク dispatch をブロック
3. tasks id=48〜51 の `rollbacked` が誤判定である可能性

---

## 2. 調査方法と取得データ

### 2-1. DB 実機確認 (sqlite3)

```
id=4  tier=S  state=running  session_id=92213cb6-8b47-4e11-8564-f1363e9baac7
      started_at=2026-05-29 00:41:19  attempt_count=1  last_action=dispatched
      worktree=…/lane-4-tier-s-prod-change-r2c-24h-uata
```

→ **session_id は NULL ではない**。resolver が正常に書き込んでいた。

### 2-2. `claude agents --json` 実機確認

```json
{
  "pid": 76958,
  "sessionId": "92213cb6-8b47-4e11-8564-f1363e9baac7",
  "name": "auto-s-4",
  "status": "waiting"
}
```

→ **セッションはアタッチ済み**。ただし `status = "waiting"` で停止中。

### 2-3. lane-4.log / lane-4.log.sid 確認

```
# lane-4.log
backgrounded · 92213cb6 · auto-s-4
  claude agents             list sessions
  ...

# lane-4.log.sid
[2026-05-29T09:41:22+0900] session_id resolved: task=4 sid=92213cb6-…
```

→ session は起動直後に解決されており、Lane は `claude --bg` でバックグラウンド起動に成功している。

### 2-4. supervisor ログ確認

```
[2026-05-29_09:28:14] === r2c-supervisor start ===  →  running|1
[2026-05-29_09:37:16] running|2
[2026-05-29_09:41:16] running|1
```

→ 09:41 時点でまだ stuck 検出閾値 (45min) に達していないため supervisor はまだ kill していない。
　 次の kill は `10:26 JST` 頃。

---

## 3. 根本原因

### 根本原因①: Tier-S = `--permission-mode plan` → "waiting" が永続する

`r2c-dispatch.sh` は tier=S のタスクに `perm_mode="plan"` を使う:
```bash
S) perm_mode="plan" ;;
```

`plan` モードは「Claude がプランを提示し、人間が承認するまで実行しない」モード。
バックグラウンドセッション (`claude --bg`) でこのモードを使うと:
1. Lane はプロンプトを受け取り、プランを生成する
2. **人間の承認待ちで `status="waiting"` のまま停止する**
3. 人間がターミナルで `claude attach <sid>` して承認しない限り、永遠に waiting

Supervisor は `started_at < now - 45min` でのみ stuck を判定し、
`claude agents --json` で `status` を確認しない。
→ 45分後に kill → re-queue → また 45分後に kill → 3回でロールバック。

**つまり Tier-S タスクは plan モードである限り、supervisorによって必ずrollbackされる。**

### 根本原因②: "session未アタッチ" という観察は誤り

観察者が `running|1` (supervisor ログ) を見て「session が NULL のまま固着」と判断した可能性が高い。
実際には:
- `session_id` は `r2c-lane-session-resolver.sh` により起動 10 秒以内に書き込まれる
- `claude agents` で session は確認できる

**session未アタッチ**という症状は発生していない。

### 根本原因③: single-slot ブロッキングは事実だが、原因は plan モード

- MAX_SLOTS=3 のうち task 4 (Tier-S) が 1 slot を占有
- waiting 状態の task 4 は自走で完了できないため slot を永続占有する
- 45min で kill → 再dispatch → また waiting → を繰り返し、合計 2.25h (45min × 3) 間 1 slot が無駄になる

### 根本原因④: tasks 48〜51 の rollback は誤判定ではない

```
id=48  tier=B  rollbacked  3 attempts  error: stuck > 45min for 3 attempts
id=49  tier=B  rollbacked  3 attempts  error: stuck > 45min for 3 attempts
id=50  tier=B  rollbacked  3 attempts  error: stuck > 45min for 3 attempts
id=51  tier=B  rollbacked  3 attempts  error: stuck > 45min for 3 attempts
```

これらは **Tier-B** タスク。`plan` モードではなく `default` モードで dispatch されている。
Tier-B で 45min × 3回 stuck になるのは、タスク自体のプロンプト/コンテキストに問題がある場合
（例: missing file、invalid worktree、prompt 未生成のまま dispatch 等）。

dispatch ログを確認すると task 48 と 49 は **各3回ずつ** `r2c-generate-lane.sh` から dispatch されており、
generate-lane の結果が毎回 prompt_generated に昇格されているが Lane が stuck している。
これは prompt または worktree に根本的な問題がある。

→ **rollback 判定自体は正しい**。誤判定ではない。ただし連続 rollback の根本原因 (task 48/49 の内容) は別途調査が必要。

---

## 4. 現状整理

| 症状 | 実態 | 重大度 |
|---|---|---|
| Tier-S session 未アタッチ | **誤り**: session は正常に解決済み | - |
| Tier-S running 固着 | **事実**: plan モードで waiting 停止中 | 中 |
| single-slot ブロッキング | **事実**: waiting → supervisor kill ループで 2.25h 浪費 | 中 |
| tasks 48〜51 rollback 誤判定 | **誤り**: rollback は正当。タスク内容に問題あり | - |

---

## 5. 修正提案

### 修正A (高優先): Tier-S に `plan` モードを使わない

`r2c-dispatch.sh` の perm_mode 決定ロジックを変更:

```bash
# 現行
S) perm_mode="plan" ;;

# 案1: bypassPermissions (CLAUDE.md の安全装置を信頼)
S) perm_mode="bypassPermissions" ;;

# 案2: auto (ほとんどの操作を自動承認、一部のみ確認)
S) perm_mode="auto" ;;
```

Tier-S の本来の意図は「VPS デプロイ・DB マイグレーション等の不可逆操作を人間が確認する」だが、
これは `plan` モードで担保するより `CLAUDE.md` の `24h 自走中の禁止操作` で担保する方が自走ループと整合する。

**Why:** `plan` モードはインタラクティブセッション用。`--bg` + cron dispatch の文脈では機能しない。

### 修正B (中優先): supervisor が `claude agents` status を確認する

r2c-supervisor.sh に以下を追加:
```bash
# waiting セッションを kill ではなく Pushover HIGH で通知し、skip
if claude agents --json 2>/dev/null | jq -e \
    --arg sid "$SID" '.[] | select(.sessionId==$sid and .status=="waiting")' > /dev/null; then
    notify 1 "R2C Tier-S waiting for plan approval" "Task ${TID}: ${NAME} — claude attach ${SID}"
    continue   # kill せずスキップ
fi
```

### 修正C (低優先): Tier-S の MAX_RUN_MINUTES を拡張

`r2c-supervisor.sh` で tier=S のタスクには長い timeout を適用:
```bash
# tier=S なら 480min (8h) まで待つ
MAX_RUN_S=480
```

---

## 6. 当面の対処

task id=4 (Tier-S) は現在 `waiting` で積んでいる。選択肢:

1. **そのまま待つ**: 45min 後に supervisor が kill → re-queue → 再び waiting → 計 3回で rollback
2. **手動で attach して承認**: `claude attach 92213cb6` でターミナル接続 → plan を確認して承認
3. **手動で cancel**: `sqlite3 … "UPDATE tasks SET state='cancelled' WHERE id=4;"` + `claude stop 92213cb6`

修正Aを実装するまでの間は、Tier-S タスクを pending のまま残し dispatch しないことを推奨する。

---

## 7. tasks 48〜51 の別途調査が必要な点

rollback された 4 タスクのプロンプトが正常に生成されていたか確認が必要:
```bash
sqlite3 .claude/queue/r2c-queue.db "SELECT id, asana_name, prompt_path FROM tasks WHERE id IN (48,49,50,51);"
```

これらが `prompt_path=NULL` だったり、worktree が壊れていたなら、
generate-lane の失敗を dispatcher が拾えていない可能性がある。

---

## 参照

- `SCRIPTS/r2c-dispatch.sh` — `perm_mode` 決定ロジック
- `SCRIPTS/r2c-supervisor.sh` — stuck 検出ロジック (MAX_RUN_MINUTES=45)
- `SCRIPTS/r2c-lane-session-resolver.sh` — session_id 自動解決
- `docs/24H_LOOP_RETRY_AND_NOTIFICATION_SPEC.md` — retry 戦略
- `docs/postmortem/2026-05-28-oauth-fail/` — 前回の session 問題事例
