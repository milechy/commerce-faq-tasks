# 24hループ ヘルスチェック監視追加 (5軸)

## Asana親
RAJIUCE Development (GID 1213607637045514)

## 背景
2026-05-28 e2e検証で 24h ループ機能停止の真因を 6 層特定 (memory#27 参照):

1. OAuth daemon 凍結 (5/26 22:55 JST、PR #197 で警告経路、復旧手段 claude /login)
2. `--prompt-file` 廃止 (PR #218 で stdin pipe 化解消)
3. `dispatch.sh:185` の `export PATH=` (PR #219 で撤廃)
4. lane-*.log の 0byte/223byte 解釈 (memory#27 で正しい判定手順を記録)
5. `cron-wrapper.sh` の親 env 継承 (PR #220 で env -i 化解消)
6. **launchd session/domain attribute** (本日判明、未修正)

検出は手動 e2e 投入と log 解析で逐次判明。常設監視がなければ次回発生時も同様に長時間 (5/26 では 22 時間) 遅延する。

## 実装方針 (5 監視を 1 スクリプト + 1 launchd plist に統合)

### `SCRIPTS/monitor-claude-health.sh` (新規)
5 分毎に以下 5 軸を実行、いずれか異常で Slack `#rajiuce-dev` (C0AG07HFJTB) 通知:

#### A. OAuth fail 監視 (罠1)
- `~/.claude/daemon-auth-status.json` 存在 + `.status == "auth_required"` → **critical**
- `~/.claude/daemon-auth-cooldown` 存在 → critical
- 復旧記録: ファイル消失検出時に「復旧通知」を 1 回送信 (throttle 対象外)

#### B. claude --version 差分監視 (罠2 再発検出)
- 直近の `claude --version` を `~/.claude-r2c-config/state/last-claude-version.txt` に保存
- 変化があれば **warning** 通知 (`--prompt-file` 級の breaking change 再発を即検出)
- 変化検出時のメッセージに「24h ループ動作確認 e2e を実施せよ」のリンク同梱

#### C. lane-*.log 0byte 連続検出 (罠3/5/6 兆候)
- `~/.claude-r2c-config/logs/lane-*.log` のうち、過去 1 時間以内 created で size=0 のものをカウント
- 2 件以上 → **warning** (1件は短 prompt 正常exit可能性、2件以上は spawn 機能不全の疑い)
- 5 件以上 → **critical** (即時介入)

#### D. dispatch idle 検出 (罠2/3/5 兆候、agents --json 空 + pending>0)
- `claude agents --json | jq 'length'` == 0
- かつ `sqlite3 r2c-queue.db "SELECT COUNT(*) FROM tasks WHERE state='prompt_generated'"` > 0
- → **critical** (dispatch が拾わずに pending 滞留)

#### E. session_id 未取得検出 (罠5/6 兆候、本日追加)
- `SELECT COUNT(*) FROM tasks WHERE state='running' AND session_id IS NULL AND started_at < datetime('now', '-60 seconds');`
- 1 件以上 → **warning** (resolver が 60 秒以内に書き戻すはず)
- 3 件以上 → **critical** (cron context spawn 機能不全)

### `SCRIPTS/launchd/com.r2c.monitor.plist` (新規)
- StartInterval=300 (5分)
- WorkingDirectory=`~/projects/commerce-faq-tasks`
- stdout/err: `~/.claude-r2c-config/logs/monitor.log`

### Throttle (PR #197 と同じパターン)
- `~/.claude-r2c-config/state/monitor-throttle.json` に 5 軸 × {critical/warning} の最終通知時刻を保存
- 同一軸 × 同一レベルは **6h 抑止**
- 「復旧通知」は throttle 対象外（即時送信）

### 検証
- A: `daemon-auth-status.json` を手動で `auth_required` に書き換え → Slack critical 発火
- B: `last-claude-version.txt` の中身を `2.1.0` に書き換え → diff 検出 warning
- C: `~/.claude-r2c-config/logs/lane-99.log` を 0byte で 3 個 touch → warning 発火
- D: 全 `claude --bg` を停止 + `prompt_generated` 1件投入 → critical 発火
- E: queue で `UPDATE tasks SET state='running', session_id=NULL, started_at=datetime('now','-120 seconds') WHERE id=...;` → warning 発火
- 通知発火後の throttle 6h 内重複抑止
- 復旧通知の即時送信

## 拡張可能性 (将来)
- PagerDuty / Pushover 連携 (深夜は critical のみ Pushover)
- `claude agents --json` の累積 zombie session 数監視 (10本超で warning)
- `~/.claude/daemon.log` の `[bg] bg settled` パターン頻度監視
- 罠 6 解消後: launchd 実起動由来 Lane の生死監視

## 関連
- `docs/postmortem/2026-05-28-oauth-fail/`
  - `MEMORY_27_DRAFT.md` (罠 6 層 + 切り分け手順)
- PR #197 (auth fail-fast 化、stderr 出力)
- PR #217 (resolver、session_id 自動発見)
- PR #218 (stdin pipe 化、--prompt-file 廃止対応)
- PR #219 (dispatch.sh の export PATH 撤廃)
- PR #220 (cron-wrapper の env -i 化)
- 未着手: 罠6 (launchd session/domain attribute) 解消 PR
