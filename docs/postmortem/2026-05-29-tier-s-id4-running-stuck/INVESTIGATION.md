# 調査レポート: Tier-S id=4 running固着 + single-slotブロッキング (2026-05-29)

**発生日時**: 2026-05-29 02:08〜(UTC) / 11:08〜(JST)  
**調査 Lane**: id=53 (auto-b-53)  
**Asana GID**: 1215236154458123  
**影響**: 全 3 slot (id=4/52/53) 占有、dispatch 凍結

---

## 1. 観測された事象

```
sqlite3 r2c-queue.db "SELECT id, tier, state, attempt_count, session_id, started_at FROM tasks WHERE id IN (4,52,53);"
```

| id | tier | state   | attempt_count | session_id (DB)                      | started_at (UTC)       |
|----|------|---------|---------------|--------------------------------------|------------------------|
| 4  | S    | running | 3             | 002d25a9-dcc5-4fbf-a523-963ed609c022 | 2026-05-29 02:12:45    |
| 52 | B    | running | 3             | 2c20c319-3135-4218-9f41-78f12ed35a9e | 2026-05-29 02:08:42    |
| 53 | B    | running | 3             | 4d07e73d-8440-4a5a-9121-37db40b84c53 | 2026-05-29 02:12:46    |

- `ACTIVE_COUNT=3`, `MAX_SLOTS=3` → dispatch は `No free slots (active=3/3)` で全 cycle skip
- task id=4 (Tier-S): ps aux で `auto-s-4` プロセス (PID 63632) 確認 — **実際には稼働中**
- task id=52 (Tier-B): ps aux で `auto-b-52` プロセス **なし** — 3rd attempt session が消滅
- task id=53 (Tier-B): これ自体が本調査 Lane — 正常稼働中

---

## 2. 根本原因 (RC1〜RC4)

### RC1: session_id 不一致 → pkill が no-op (session未アタッチの実態)

**lane-4.log (5行のみ)**:
```
backgrounded · 4aa73086-909a-4f5e-8740-9cb1012f7398 · auto-s-4
  claude agents             list sessions
  claude attach 4aa73086    open in this terminal
  ...
```

**resolver log (lane-4.log.sid)**:
```
[2026-05-29T11:12:47+0900] session_id resolved: task=4 sid=002d25a9-dcc5-4fbf-a523-963ed609c022
```

バナーが示す session_id (`4aa73086`) と、resolver が `claude agents --json` から拾った session_id (`002d25a9`) が **一致しない**。

**原因**: `r2c-lane-session-resolver.sh` は `claude agents --json | select(.name=="auto-s-4") | .sessionId | head -1` で取得するが、新 dispatch で新セッションが作られても `claude agents --json` には**旧 attempt の session が残存**する。`head -1` が旧 session を返すため DB に陳腐な session_id が書き込まれる。

```
attempt 1 → session A (例: 92213cb6)  ← resolver が A を DB に書く
  supervisor: stuck → pkill -f "claude.*A" (成功 or 失敗)
attempt 2 → session B (例: 002d25a9)
  resolver 実行 → claude agents --json には A と B が両方残存
  head -1 が A を返す → DB は A のまま (更新なし or 誤更新)
  supervisor: stuck → pkill -f "claude.*A" → no-op (B が生き残る)
attempt 3 → session C (例: 4aa73086)  ← バナー表示
  resolver → head -1 が 002d25a9 を返す → DB は 002d25a9
  supervisor (次回): pkill -f "claude.*002d25a9" → no-op (C = 4aa73086 が生き残る)
```

**結果**: 各 retry で orphan session が蓄積。supervisor の pkill が常に空振り。

---

### RC2: MAX_ATTEMPTS 到達後の Tier-S rollback 誤判定

`r2c-supervisor.sh` の rollback 判定:

```bash
MAX_ATTEMPTS=3   # スクリプト定数

ATTEMPT_NUM=${ATTEMPT:-0}
if [ "$ATTEMPT_NUM" -lt "$MAX_ATTEMPTS" ]; then
    # retry
else
    # rollback
fi
```

task id=4 は `attempt_count=3`, `MAX_ATTEMPTS=3` → `3 < 3` = false → **次回 supervisor 実行 (11:57 JST) で rollback に確定**。

しかし task id=4 の auto-s-4 プロセス (PID 63632) は **ps aux で現在も稼働中**。Tier-S タスク (R2C 24h自律ループ導入) は本質的に 45 分以上かかる大規模作業。45 分のタイムアウトは Tier-B 向けに設計されており、Tier-S への適用は不適切。

**誤判定の構造**:
- stuck 判定が時間ベース (45 min) のみで、活動ベースの判定なし
- Tier S/A/B 共通の `MAX_RUN_MINUTES=45` が Tier-S に対して短すぎる
- rollback が `pkill -f "claude.*002d25a9"` (RC1 の誤 ID) で走るため、実際のプロセスは kill されない
- → 実プロセスは生きたまま、DB 状態は `rollbacked` に → 次回 dispatch でも slot を食わないが、orphan session は残る

---

### RC3: single-slot blocking の連鎖

1. task 52 (11:08 dispatch) → session 305bb259 がほぼ即死 (原因不明、要追加調査)
2. task 4, 52 が slot を 2 つ占有したまま 45 min 通過待ち
3. task 53 (この Lane) が slot 3 番目を占有
4. `active=3/3` → dispatch が全 cycle skip (11:13〜 継続中)

task 52 の各 attempt で session_id が一致し続けた (`2c20c319` が 3 回とも同じ) のは、resolver が常に同じ古い session を返し続けたため。実際の各 attempt の session (`A → B → 305bb259`) は DB に反映されていない。

---

### RC4: DB `last_supervisor_run` 更新失敗 (軽微)

`automation_state.last_supervisor_run = 2026-05-29T02:15:43Z` (= JST 11:15) に固着。  
実際には supervisor は毎分実行されている (ログで確認: 11:13〜11:18 連続)。

末尾の `|| true` で INSERT エラーが抑制されている。WAL モードの SQLite でも同時書き込み競合で INSERT が落ちることがある。影響は監視上の不一致のみで、supervisor の動作自体は正常。

---

## 3. タイムライン

| JST 時刻 | 事象 |
|---------|------|
| ~09:36  | task 4, 52 attempt 1 dispatch |
| ~10:22  | supervisor: task 4, 52 stuck 45min → pending (attempt_count 変更なし) |
| ~10:22  | dispatch: attempt 2 開始, attempt_count → 2 |
| ~11:08  | supervisor: attempt 2 stuck → pending; dispatch: attempt 3 開始, attempt_count → 3 |
| 11:08:45 | resolver: task 52 → sid=2c20c319 (stale); task 52 の実 session 305bb259 は短命で消滅 |
| 11:12:47 | resolver: task 4 → sid=002d25a9 (stale); 実 session 4aa73086 は稼働中 |
| 11:12〜  | dispatch: active=3/3, 以降全 cycle skip |
| **11:57** | **supervisor: task 4 stuck 45min 検出予定, attempt_count=3 → rollback 確定** |
| **11:53** | **supervisor: task 52 stuck 45min 検出予定, attempt_count=3 → rollback 確定** |

---

## 4. 推奨アクション

### 即時 (hkobayashi 手動)

1. **task 4 (Tier-S) を守る**: 11:57 前に以下を実行して rollback 回避
   ```bash
   # started_at をリセットして stuck タイマーを延長
   sqlite3 ~/.claude-r2c-config/../projects/commerce-faq-tasks/.claude/queue/r2c-queue.db \
     "UPDATE tasks SET started_at=datetime('now') WHERE id=4;"
   # または attempt_count を下げる (supervisorが retry に回す)
   sqlite3 /path/to/r2c-queue.db "UPDATE tasks SET attempt_count=2 WHERE id=4;"
   ```

2. **task 52 を整理**: プロセスが存在しないため rollback が正しい
   ```bash
   sqlite3 /path/to/r2c-queue.db \
     "UPDATE tasks SET state='rollbacked', error_message='session死亡・手動', last_action='manual_rollback' WHERE id=52;"
   ```

3. task 53 (この Lane) が PR 作成後に完了 → 1 slot 空く
4. task 52 を手動 rollback → 1 slot 空く → dispatch 再開

### 構造的修正 (follow-up issues として起票推奨)

| # | 修正内容 | 影響スクリプト |
|---|---------|--------------|
| F1 | resolver: `claude agents --json` を `sort -k started_at -desc` 等で最新 session を取得 | r2c-lane-session-resolver.sh |
| F2 | resolver: バナー出力 (`backgrounded · <SID>`) を直接 log から grep して取得する代替手段 | r2c-lane-session-resolver.sh |
| F3 | Tier 別 MAX_RUN_MINUTES: S=120, A=90, B=45 | r2c-supervisor.sh |
| F4 | pkill 失敗時のフォールバック: lane_name で `pkill -f "auto-s-4"` を試みる | r2c-supervisor.sh |
| F5 | DB `last_supervisor_run` 更新失敗をエラーレベルでログに残す (|| true 削除) | r2c-supervisor.sh |
| F6 | session_id mismatch を supervisor が検出してアラートする | r2c-supervisor.sh |

---

## 5. 検証コマンド (再発確認用)

```bash
# session_id が実プロセスと一致しているか確認
for id in 4 52 53; do
  db_sid=$(sqlite3 ~/.../r2c-queue.db "SELECT session_id FROM tasks WHERE id=$id;")
  ps aux | grep -c "$db_sid" && echo "task $id: MATCH" || echo "task $id: MISMATCH (db=$db_sid)"
done

# 実際の auto-s-4 session
ps aux | grep "name auto-s-4" | grep -v grep
# → --session-id <SID> で確認

# claude agents の現在 session 一覧
claude agents --json | jq -r '.[] | [.name, .sessionId] | @tsv'
```

---

## 6. 関連 PR / ドキュメント

- PR #234: `COALESCE で started_at=NULL タスクの stuck 検出漏れを修正` (supervisor: 別の stuck 検出バグの修正)
- docs/postmortem/2026-05-28-oauth-fail/MEMORY_27.md: 罠1〜6 の体系
- docs/24H_LOOP_RETRY_AND_NOTIFICATION_SPEC.md §1: supervisor 設計仕様
