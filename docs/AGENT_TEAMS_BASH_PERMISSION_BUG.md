# Agent Teams 4th Teammate Bash 権限取得失敗 — 調査レポート

> 作成: 2026-06-05 (PR #252 revert 後の再調査版)
> Asana GID: 1214886048341241
> PR 歴: #252 追加 → #253 revert（spawn checker 3欠陥）→ 本ドキュメント
> 分類: Tier B (ops)

---

## Section 1: 2026-05-18 事案記録

### 1.1 発生状況

| 項目 | 内容 |
|---|---|
| 発生日時 | 2026-05-18 Phase 1 Step E |
| 実行コマンド | Agent Teams 4 teammates 並列 spawn |
| 失敗 teammate | E-D（4 番目のみ） |
| 正常 teammate | E-A, E-B, E-C（1-3 番目） |
| 失敗内容 | Bash ツール権限取得失敗。TeamLead が代わりに実装 |

### 1.2 ログ保全状況

当該セッションのログは保全されていない（事案発生時はログ収集未整備）。
以後のセッションから `SCRIPTS/r2c-dispatch.sh` が `logs/lane-*.log` に出力を記録している。

### 1.3 再発リスク

Lane Pool 5 本並列実行（Phase 1 以降）で同様の失敗が発生すると:
- 4 番目 Lane が Bash ツールなしで idle 状態になる
- 45 分後に supervisor が timeout 検出して re-dispatch → 稼働率 4/5 で継続
- 実害は「タスク消費速度 20% 低下」に相当

---

## Section 2: 再現試験設計

### 2.1 試験ケース

| TC | 並列度 | spawn 方式 | 期待結果 |
|---|---|---|---|
| TC-1 | 1 | sequential | 常に成功するベースライン確認 |
| TC-2 | 3 | 並列（現行 MAX_SLOTS=3） | 正常を確認 |
| TC-3 | 4 | 並列（MAX_SLOTS=4 に一時増加） | 4 番目失敗を確認（再現）|
| TC-4 | 4 | sequential（1秒間隔） | 遅延 spawn で問題解消するか |
| TC-5 | 3 | 並列 + ulimit -n 256 強制 | maxfiles 制約の寄与を確認 |

### 2.2 試験未実施の理由

- Anthropic API コスト（spawn 1 回 ≒ Opus トークン消費）に見合う追加情報なし
- 現行 MAX_SLOTS=3 で問題が発生していないため再現環境が難しい
- issue #25037 の既知バグとして原因仮説に十分な根拠がある

---

## Section 3: 原因特定

### 3.1 主因仮説: Agent Teams issue #25037

**Claude Code issue #25037**: teammates が TeamLead の制限された tool access を継承する既知バグ。

- TeamLead が `--permission-mode plan` で起動している場合、spawn された teammate も同じ制限を継承
- 4 番目 teammate だけが失敗する場合、spawn タイミングのレースコンディションで一時的なロック競合が起きている可能性
- 2026-05-18 時点の Claude Code バージョンは 2.1.83 付近（現在 2.1.143+）

**現在の緩和状況**: r2c-dispatch.sh では `--permission-mode bypassPermissions`（Tier S/A）または `plan`（Tier B）を明示的に指定するよう変更済み（PR #285）。これにより TeamLead 継承問題は軽減されている。

### 3.2 増悪因子: launchctl maxfiles 制約

```
ulimit -n       = 1048576  (プロセス上限 = 問題なし)
launchctl soft  = 256      (launchd セッション = 制限あり)
launchctl hard  = unlimited
```

launchd 経由での起動時（cron）は soft=256 が適用される。
4 並列 claude --bg が開くファイルディスクリプタ数が 256 に達すると spawn 失敗する。
対策: `ulimit -Sn 65536` を cron-wrapper.sh に追加済み（PR #221）。

### 3.3 現状評価

| 原因 | 2026-05-18 時点 | 現在（2026-06-05） | 残存リスク |
|---|---|---|---|
| tool access 継承 | permission-mode 未指定 | bypassPermissions 明示 | 低（修正済み） |
| maxfiles soft=256 | 対策なし | cron-wrapper.sh で ulimit 拡張 | 低（修正済み） |
| spawn タイミング race | 不明 | MAX_SLOTS=3 で制限 | 中（未修正）|

---

## Section 4: 回避策評価

| オプション | 内容 | 評価 | 採否 |
|---|---|---|---|
| **Option A** | MAX_SLOTS=3 で並列度制限 | 既に実装済み（CLAUDE.md §並列上限）。UATa 実測で 3本超で result drop 多発。 | ✅ **採用済み** |
| **Option B** | tmux 独立セッション × 5 | インフラ複雑化。r2c-dispatch.sh との統合が困難。 | ❌ 見送り |
| **Option C** | `--model opus` 明示 + ulimit チューニング | ulimit は対処済み。model 明示は dispatch.sh で実装済み。 | ✅ 部分的に採用済み |
| **Option D** | Anthropic へバグ報告 | issue #25037 に事例追記。ただし修正 ETA 不明。 | 🔄 任意 |

**現時点の推奨**: Option A（MAX_SLOTS=3）で十分な緩和が達成されている。
追加対策として spawn 失敗検出ガードを dispatch.sh に追加することで「失敗時の自動 degraded モード継続」を実現する（Section 5 参照）。

---

## Section 5: SCRIPTS/r2c-dispatch.sh へのガード追加仕様

### 5.1 PR #252 の 3 欠陥と修正方針

PR #252 で実装した spawn checker を PR #253 で revert した理由:

| 欠陥 | 詳細 | 修正方針 |
|---|---|---|
| ① kill シグナル欠落 | nohup プロセスを kill せずに state='failed' → プロセスが残留してリソース消費 | dispatch_one 内で `nohup_pid=$!` を disown 前に記録し、checker スクリプトに渡す |
| ② 窓幅短すぎ（60 秒） | Claude Code が起動してプロンプト処理を開始するまで最大 90〜120 秒かかるため、正常 Lane を誤検知 | SPAWN_WINDOW を 180 秒に延長（UATa 実測: 120 秒以内に活動開始） |
| ③ session_id 残存 | 失敗 Lane の session_id を消去せず state='failed' にしたため、re-dispatch 時に旧 session_id が残り二重 dispatch を誘発 | `UPDATE tasks SET state='failed', session_id=NULL ...` として session_id を同時クリア |

### 5.2 修正後の spawn checker 仕様

```
r2c-lane-spawn-checker.sh --task-id N --lane-name L --log-file F --nohup-pid P
  1. sleep SPAWN_WINDOW (=180)
  2. 失敗判定: log 存在しない / 0byte / idle-banner のみ
  3. 失敗時:
     a. kill -TERM P (欠陥①修正)  + kill -KILL P (5秒後に強制)
     b. SQ "UPDATE tasks SET state='failed', session_id=NULL, ... WHERE id=N AND state='running';"
        (欠陥③修正: session_id=NULL を明示)
     c. Pushover priority=1 通知（3 回目以降のみ: consecutive_failures カラム参照）
  4. 成功時: ログ出力のみ（DB 変更なし）
```

### 5.3 dispatch_one への組み込み差分（疑似コード）

```bash
# dispatch_one 内 nohup 直後
nohup bash -c "..." > /dev/null 2>&1 &
nohup_pid=$!          # ← 追加 (欠陥①対策)
disown "$nohup_pid"

# spawn checker をバックグラウンドで起動
nohup bash "${R2C_ROOT}/SCRIPTS/r2c-lane-spawn-checker.sh" \
    --task-id "${task_id}" \
    --lane-name "${lane_name}" \
    --log-file "${log_file}" \
    --nohup-pid "${nohup_pid}" \
    > /dev/null 2>&1 &
disown
```

### 5.4 degraded モード（4 つ目 teammate 失敗時）

spawn checker が 4 番目 Lane を `state='failed'` に遷移させると:
- `ACTIVE_COUNT` が 4→3 に減少
- 次の cron サイクル（1 分後）で `AVAILABLE_SLOTS=3-3=0` となり新規 dispatch なし
- 5 分後の supervisor が timeout Lane を検出して retry キューに戻す
- 実質 3 並列の degraded モードで継続

**既存の MAX_SLOTS=3 制約と整合**: 通常は 3 本以上 dispatch されないため、4 本目失敗シナリオはレアケース。spawn checker は「起動後 3 分で確認するセーフティネット」として機能する。

### 5.5 実装予定 PR

- `SCRIPTS/r2c-lane-spawn-checker.sh` 新規作成
- `SCRIPTS/r2c-dispatch.sh` に nohup_pid 取得 + checker 起動を追加
- `pnpm verify` N/A（bash のみ）、`bash -n` 構文チェック必須
- Asana: 本タスク GID 1214886048341241 で完了後クローズ（または別タスク起票）

---

## 関連ファイル

- `SCRIPTS/r2c-dispatch.sh` — dispatch ロジック本体
- `SCRIPTS/r2c-lane-session-resolver.sh` — session_id 自動解決（同パターン）
- `docs/postmortem/2026-05-28-oauth-fail/MEMORY_27.md` — launchd 環境 6 罠まとめ
- CLAUDE.md §「24h ループ安定性ガード」 — MAX_SLOTS=3 根拠
