# R2C 24h 自走 起動チェックリスト v1.1

**版数:** 1.1 (正式版 — Phase70-K 2026-05-20)
**作成日:** 2026-05-19 v1.0、改訂 2026-05-19 v1.1、正式化 2026-05-20 Phase70-K
**位置づけ:** Phase70-H 初回 12h パイロット起動の前提条件
**出典:** UATa 24h 自走運用テンプレ v1.0 (2026-05-19 09:00 JST) + UATa 1日実体験生記録 v1.0 (2026-05-19 18:00 JST) を R2C 固有の制約に合わせてカスタマイズ
**関連ドキュメント:**
- `docs/24H_AUTONOMOUS_PLAYBOOK.md` — 論理ブロック安全装置 + 起動/停止スクリプト操作手順
- `docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md` — UATa vs R2C ギャップ分析
- `docs/24H_AUTOMATION_RUNBOOK_R2C.md` — R2C 24h 自走 初期構築手順書
- `docs/24H_LOOP_LEARNING_INTEGRATION.md` — 学習ループ統合仕様
- `docs/24H_LOOP_RETRY_AND_NOTIFICATION_SPEC.md` — Lane retry 戦略 + Pushover 通知仕様
- `docs/PHASE70_AI_CROSSCHECK.md` §5.5 (24h 起動の足場整備という発見)

---

## 0. R2C 固有の前提と UATa との差分

| 項目 | UATa | R2C | 影響 |
|---|---|---|---|
| **本番環境** | dev VPS + staging + prod (Blue/Green) | VPS 1 台 (本番のみ、staging 無し) | 物理閉鎖が取れない、論理ブロック必須 |
| **Admin UI** | 自前 deploy | Cloudflare Pages auto-deploy from main | main merge 停止が即 deploy 停止 |
| **Gate 2.5 plugin** | Codex review (使用) | **旧 `/codex:review` を継続**(R2C 未移行)、新 `code-review` は他プロジェクトのみ | コマンド名要注意 |
| **DB migration** | alembic 自動適用 | **VPS 手動 SQL 実行** (CLI 不可、deploy_guard でブロック) | CLI が migration ファイル作成のみ、適用は人間 |
| **stuck-detector** | 既に運用中 | 未整備 | 70-A 範囲外、別タスク化候補 |
| **24h ループ基盤** | 16 ファイル運用中 (UATa 5/17 完了) | 70-A/B/D/J/L 完了 = 50% (2026-05-19 21:30 時点) | 約 2 日遅れだが朝より大幅前進 |
| **frontend build** | OOM 経験あり (UATa 2026-05-19 §4.3) | Cloudflare Pages 側ビルド = ローカル/VPS の OOM リスクなし | R2C 優位 |

→ **R2C は UATa より物理隔離が弱い、論理ブロックに 100% 依存**。3 AI クロスチェック §G1 で警告された「論理ブロックすり抜け」リスクが極大化する構造。

### v1.1 で新たに反映した UATa 実体験

UATa 1 日実体験生記録 (2026-05-19 18:00 JST) から、以下を v1.1 で取り込み:

1. **タスクキュー 30-50 本先積み**(§5 #9): 夜間 8h 消化想定でタスク不足になると Lane 停止 → R2C も同じリスク
2. **VPS メモリ余裕事前確認**(§4.3): UATa は frontend build OOM 経験、R2C は CF Pages 側ビルドなのでローカル OOM リスクは少ないが、API/Widget/avatar-agent のメモリ使用量は事前確認
3. **deploy 失敗時の docker ps -a + volume 生存確認**(§4.1): UATa は本番 8 コンテナ中 7 消失経験、R2C は単一 PM2 だが類似事故ありうる
4. **焼き込み grep 検知**(§4.2): UATa は Blue/Green コード不整合経験、R2C は単一本番だが deploy 後の grep 確認は必要
5. **「3 回ルール」明文化**(§4.21 + UATa PR #246): 同系統失敗 3 回で資格喪失、R2C もメモリで運用中だが明文化必要

---

## 1. 安全装置の階層 (R2C 版)

### 1.1 R2C 固有の安全境界 (物理閉鎖が取れない代替)

UATa の §1.1 は「本番 SSH 経路を物理閉鎖」が前提だが、R2C はそれが取れない。代替策:

- **論理ブロック**: deploy_guard.py で SSH/VPS コマンドを完全遮断 (PR #176 Phase70-A 完了済)
  - `R2C_24H_MODE=1` 環境変数または `~/.r2c-24h-mode` ファイル存在で発火
  - SSH コマンド deny-by-default + 最小ホワイトリスト
  - 引用符付き SSH も block (Codex Round 3 P1-b 対応済)
  - **コマンド置換** (`$(ssh ...)`, `` `ssh...` ``) も block (Codex Round 5 P1 対応済)
  - **連結コマンド** (`pnpm build && ssh ...`) も block (Codex Round 4 P1-b 対応済)
- **main への auto-merge 停止**: 24h-mode-on.sh で branch protection 強化 (PR #176 完了済)
- **branch protection 復元**: GET response → PUT body 変換で lossless 復元 (Codex Round 7 対応済)
- **CF Pages 手動停止**: 24h-mode-on.sh が指示出力、人間が手動で CF 側 deploy 停止
- **書籍 PDF / .env / .key / secrets/**: .claudeignore で除外 (PR #176)

✅ チェック項目:
- [ ] `R2C_24H_MODE=1` で `bash SCRIPTS/deploy-vps.sh` が block されることを実機確認
- [ ] `ssh root@65.108.159.161` と `ssh "ubuntu@api.r2c.biz" "pm2 list"` の両方が block されることを実機確認
- [ ] `pnpm build && ssh root@...` 連結コマンドが block されることを実機確認
- [ ] `$(ssh root@...)` コマンド置換が block されることを実機確認
- [ ] main への直接 push が branch protection で reject されることを確認
- [ ] **【v1.1 追加】 VPS のメモリ使用率事前確認**(API/Widget/avatar-agent の合計 + バッファ余裕)

### 1.2 通知経路 (R2C 版)

| 重要度 | 経路 | 用途 | 現状 |
|---|---|---|---|
| INFO | Slack #r2c (C0AG07HFJTB) via Slack MCP | Phase 完了、PR 作成、通常進捗 | 既存運用中 |
| INFO | Slack #r2c via webhook URL (curl) | MCP transient 時の fallback | **70-L 完了済** (PR #179) |
| WARN | Slack #r2c 同上 + Asana コメント | 想定外 blocker / レビュー依頼 | Asana MCP 既存運用 |
| CRITICAL | (検討中) Pushover or 他経路 | 夜間でも起こす緊急停止 | **未整備、70-H 後判断** |

✅ チェック項目:
- [x] `SCRIPTS/notify-slack.sh` で MCP / curl 両経路の test 投稿成功 (PR #179 完了)
- [x] webhook URL が `.env` (gitignore済) に格納、`.env.example` にプレースホルダーあり
- [ ] Stop 連投防止フラグの動作確認 (`~/.claude-r2c-config/.r2c-notified-stop`)
- [ ] (オプション) Pushover 等の緊急通知経路を検討、未採用なら明文化
- [ ] **【v1.1 追加】 notify-slack.sh の JSON escape 強化** (Asana GID:1214924959113051, due 5/26 完了)

### 1.3 stuck 検知 (R2C 版)

UATa が報告した既知バグ:
- Claude Code TUI で `[Tool result missing due to internal error]` 発生 → Lane 無音停止
- 並列 tool call **3本以上で result drop 確率 10-30%**
- **最大 2本ルール必須**

UATa 実体験 (2026-05-19): 1 日で 21 回の推測ミス + stuck 状態多発。stuck-detector daemon が運用救済になった。

R2C 対応:
- [ ] 24h 自走プロンプト (70-E) に「並列 tool call は最大 2 本」を明記
- [ ] CLI 側 hook で heartbeat ファイル更新 (将来検討、70-H で必要性判断)
- [ ] 初回 12h パイロット (70-H) では人間が 4h バッチで進捗確認
- [x] **【Phase70-? 完了】 stuck-detector daemon R2C 版実装**: `SCRIPTS/r2c-stuck-detector.sh`

### 1.3.1 stuck-detector 起動方法 (R2C 版)

`SCRIPTS/r2c-stuck-detector.sh` は 24h 自走開始と同時に **別プロセスとして起動** する。

#### オプション A: launchd plist (推奨 — macOS 常駐)

`~/Library/LaunchAgents/com.r2c.stuck-detector.plist` として配置:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.r2c.stuck-detector</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/Users/hkobayashi/Documents/GitHub/commerce-faq-tasks/SCRIPTS/r2c-stuck-detector.sh</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>R2C_CONFIG</key>
        <string>/Users/hkobayashi/.claude-r2c-config</string>
        <key>STUCK_WARN_THRESHOLD</key>
        <string>1800</string>
        <key>STUCK_KILL_THRESHOLD</key>
        <string>5400</string>
        <key>STUCK_POLL_INTERVAL</key>
        <string>60</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/hkobayashi/.claude-r2c-config/logs/r2c-stuck-detector.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/hkobayashi/.claude-r2c-config/logs/r2c-stuck-detector.log</string>
    <key>RunAtLoad</key>
    <false/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>
```

起動コマンド:
```bash
launchctl load ~/Library/LaunchAgents/com.r2c.stuck-detector.plist
launchctl start com.r2c.stuck-detector
```

停止コマンド (24h 自走終了時):
```bash
launchctl stop com.r2c.stuck-detector
launchctl unload ~/Library/LaunchAgents/com.r2c.stuck-detector.plist
```

#### オプション B: cron (シンプル版)

```bash
# 毎分実行 — one-shot モードで自前ループを持たせない場合
* * * * * R2C_CONFIG=$HOME/.claude-r2c-config bash /path/to/SCRIPTS/r2c-stuck-detector.sh --one-shot >> $HOME/.claude-r2c-config/logs/r2c-stuck-detector.log 2>&1
```

#### オプション C: バックグラウンド起動 (24h-mode-on.sh から呼ぶ)

```bash
# SCRIPTS/24h-mode-on.sh の末尾に追加
nohup bash SCRIPTS/r2c-stuck-detector.sh \
    >> "${R2C_CONFIG}/logs/r2c-stuck-detector.log" 2>&1 &
echo $! > "${R2C_CONFIG}/.stuck-detector.pid"
echo "[24h-mode-on] stuck-detector started (PID $(cat ${R2C_CONFIG}/.stuck-detector.pid))"
```

停止 (24h-mode-off.sh に追加):
```bash
PID_FILE="${R2C_CONFIG}/.stuck-detector.pid"
if [[ -f "$PID_FILE" ]]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "[24h-mode-off] stuck-detector stopped"
fi
```

#### 環境変数チューニング例

| 変数 | デフォルト | 説明 |
|---|---|---|
| `STUCK_WARN_THRESHOLD` | 1800 (30分) | Slack 警告発火までの秒数 |
| `STUCK_KILL_THRESHOLD` | 5400 (90分) | session kill 発火までの秒数 |
| `STUCK_POLL_INTERVAL` | 60 (1分) | heartbeat チェック間隔 |
| `MAX_DISPATCH_ATTEMPTS` | 3 | 最大 re-dispatch 試行回数 |
| `DISPATCH_COMMAND` | (未設定) | 再dispatch コマンド (未設定時は Slack 通知のみ) |
| `PUSHOVER_APP_TOKEN` | (未設定) | Pushover 通知 token (3回失敗時に使用) |
| `PUSHOVER_USER_KEY` | (未設定) | Pushover user key |

✅ 起動前チェック項目 (§9 に追加):
- [ ] `bash SCRIPTS/r2c-stuck-detector.sh --dry-run --one-shot --verbose` で dry-run 動作確認
- [ ] `~/.claude-r2c-config/heartbeat` が 24h 自走プロンプトで定期 touch されることを確認
- [ ] launchd / cron / nohup のどれを使うかを決定し起動方法を PLAYBOOK に記載

### 1.4 重要操作の自動禁止 (`.claude/settings.json` の `permissions.deny`)

UATa の deny list + R2C 固有を追加。**Phase70-B (PR #180) で適用済**:

```json
{
  "permissions": {
    "defaultMode": "bypassPermissions",
    "autoMemoryEnabled": true,
    "cleanupPeriodDays": 99999,
    "deny": [
      "Bash(rm -rf:*)",
      "Bash(git push --force:*)",
      "Bash(git reset --hard:*)",
      "Bash(docker system prune:*)",
      "Bash(ssh:*)",
      "Bash(scp:*)",
      "Bash(rsync:*)",
      "Bash(bash SCRIPTS/deploy-vps.sh*)",
      "Edit(.env)",
      "Edit(.env.*)",
      "Edit(secrets/*)",
      "Edit(*.key)",
      "Edit(.claude/hooks/deploy_guard.py)",
      "Edit(SCRIPTS/24h-mode-on.sh)",
      "Edit(SCRIPTS/24h-mode-off.sh)",
      "Edit(.claude/hooks/*)"
    ]
  }
}
```

**※ R2C 固有の追加** (3 AI §G1 対策、自編集禁止):
- `.claude/hooks/deploy_guard.py` 自編集禁止
- `SCRIPTS/24h-mode-*.sh` 自編集禁止

✅ チェック項目:
- [x] `.claude/settings.json` の `permissions.deny` が上記内容を含む (70-B 完了)
- [x] `deny` の構文が正しい (`permissions.defaultMode` ネスト、UATa #10 教訓)
- [ ] `claude --dangerously-skip-permissions` ではなく settings.json で動作させる試み (UATa バグ 11 回避)

---

## 2. Bypass Permissions モードの正しい設定 (UATa §2 + R2C 補足)

### 2.1 公式 valid values
`default` / `acceptEdits` / `plan` / `dontAsk` / `bypassPermissions`

### 2.2 settings.json 正しい配置 (ネスト必須)

```json
{
  "permissions": {
    "defaultMode": "bypassPermissions",
    "allow": [...],
    "deny": [...]
  }
}
```

**root 直下 `defaultMode` は無効** (UATa #10 教訓: 公式 doc 通り)。

### 2.3 既知バグと回避策

複数の GitHub issue (#29026, #34923, #12604) で「正しい構文で書いても反映されない」報告継続中。

**確実な経路** (公式 doc 推奨):
```bash
claude --dangerously-skip-permissions
```

UATa の結論: これが「**唯一動く方法**」とコミュニティ確認済。

✅ チェック項目:
- [ ] R2C で settings.json による設定が動作するか実機検証 (70-H 前)
- [ ] 動かない場合は `--dangerously-skip-permissions` を 24h 自走起動コマンドに採用
- [ ] どちらを採用したか docs/24H_AUTONOMOUS_PLAYBOOK.md に明記

### 2.4 警告画面と session 再起動 (UATa #11 教訓)

Bypass Permissions モード起動時の公式警告画面で **`Yes, I accept` を選ぶと新規セッション扱い**になり、進行中タスクが lost する可能性。

R2C 対応:
- 24h 自走起動前に**全 setup を完了**させる (任意のタスク途中で起動しない)
- `/resume` で前 session 復帰、auto-memory に書かれた進捗から続行

### 2.5 起動確認
`/status` で `Bypass Permissions on` 表示。

---

## 3. CLAUDE.md / auto-memory / 知識ベース (R2C 版)

### 3.1 CLAUDE.md (リポジトリ直下)

**Phase70-B (PR #180) で完了**。**143 行**(200 行制限の 71%)。

主要セクション:
- 役割分担 (Claude.ai / CLI / hkobayashi)
- 24h 自走中の禁止操作 (10 項目、70-I で 11 項目に拡張予定)
- 学習セクション (Auto-updated by Claude Code) — auto-memory 機能で更新
- 通知経路の使い分け
- HUMAN-REVIEW-REQUIRED の定義と発火条件

UATa 教訓: CLAUDE.md 分割 (コア 25k + 教訓 40k) は **UATa 自身も未完**。R2C では最初から **200 行以下** で運用設計済 (PR #180)。

### 3.2 auto-memory (`~/.claude/projects/<path>/memory/MEMORY.md`)

セッション間で引き継ぎたい知見。Claude Code v2.1.143+ で `autoMemoryEnabled: true` 設定が必要。

**Phase70-B (PR #180) で有効化済** + `cleanupPeriodDays: 99999`。

### 3.3 OpenWolf (`.wolf/`) との役割分離 (R2C 固有)

R2C には UATa にない OpenWolf システムが並行稼働:
- `.wolf/cerebrum.md` (長期学習)
- `.wolf/memory.md` (セッション)
- `.wolf/anatomy.md` (プロジェクト構造)
- `.wolf/hooks/stop.js` (PostToolUse hook、**TCC EPERM 発生中、別タスク化候補**)

3 AI クロスチェック §C1 で**二重管理リスク高**と 3 社一致指摘。

R2C 採用案 (Gemini 案、Phase70-B で `.wolf/OPENWOLF.md` に反映済):
- `.wolf/cerebrum.md` (長期学習) = **Read-Only during 24h autonomous run**
- `.wolf/memory.md` (セッション記憶) = Read-Only during autonomous run
- `MEMORY.md` (auto-memory) = 24h 自走中の唯一の書き込み可能領域

✅ チェック項目:
- [x] `.wolf/OPENWOLF.md` に「24h 自走中は Read-Only」を明記 (70-B 完了)
- [ ] `.wolf/hooks/stop.js` の Node v24 ES module SyntaxError 解消 (**TCC EPERM 別タスク化必要**)
- [ ] **【v1.1 追加】 .wolf/hooks/stop.js の TCC 権限問題対処** (macOS フルディスクアクセス、別タスク)

### 3.4 知識ベース (Claude.ai プロジェクト) の整理 (R2C 固有)

R2C のプロジェクト知識ベース現状:
- R2C_DEVELOPMENT_PLAYBOOK.md (654 行) ✅ §11/§12 を Asana 参照化済み (70-K)
- SKILL.md (302 行) ✅ PLAYBOOK との役割境界明文化済み (70-K)
- TEST_DEPLOY_GATE.md (520 行) ⚠️ Claude in Chrome 前提、Playwright MCP に未追従
- SECURITY_SCAN_POLICY.md (75 行) ✅
- PHASE38_COMPLETION.md (52 行) ⚠️ 単発 Phase、知識ベースに残す必要性低

→ **70-K で整理予定**。24h 自走開始前に PLAYBOOK の「現在の未完了タスク」を最新化必須。

✅ チェック項目 (70-K で実施):
- [ ] R2C_DEVELOPMENT_PLAYBOOK.md §11/§12 を最新化、または「Asana 参照」と明記して静的更新廃止
- [ ] PLAYBOOK と SKILL の役割境界明文化

---

## 4. 24h 自走 起動プロンプト テンプレ (R2C 版)

CLI への指示は **一言** で十分 (UATa §4 通り)。R2C 用最小例 (70-E で完成予定):

```
これから 12h 自走 (Phase70-H 初回パイロット) に入る。
24h-mode-on.sh 実行済、bypassPermissions 設定 OR --dangerously-skip-permissions 起動済。

参照:
- CLAUDE.md (143行、PR #180)
- docs/24H_AUTONOMOUS_PLAYBOOK.md (§7 通知パターン + §8 auto-memory)
- docs/R2C_24H_STARTUP_CHECKLIST.md v1.1 (本ファイル)
- auto-memory (MEMORY.md)
- Asana RAJIUCE Development (GID:1213607637045514)

安全境界:
- 本番 VPS への書込禁止 (deploy_guard で論理閉鎖済、PR #176 commit 38f3e74)
- main への直接 push 禁止 (branch protection)
- main への merge 禁止 (auto-merge 停止済、人間が朝行う)
- DB migration ファイル作成のみ可、適用は人間
- 並列 tool call 最大 2 本
- stuck 時は Slack #r2c 通知 (SCRIPTS/notify-slack.sh)

目標 Phase 1-4 (4h バッチで進行):
- Phase 1 (0-4h): Asana Watcher (SCRIPTS/asana-watcher.sh) 取得 Tier B タスク 1-2 件着手、PR 作成
- Phase 2 (4-8h): 続けて Tier A タスク 1-2 件 (24h-eligible タグ付き)、PR 作成
- Phase 3 (8-11h): Codex review 並列、indication あれば fix commit
- Phase 4 (11-12h、最後 1h): Slack に報告 + PR 一覧 + 朝のレビュー候補リスト

停止条件:
- PR 8 件超
- high-risk タスク 1 件以上着手 (Risk Scorer 判定、70-F)
- Codex high/critical 1 件以上
- テスト fail 1 件以上
- 想定外 blocker
- DB migration 必要タスクが先頭に来た
- **【v1.1 追加】 タスクキューが 5 件未満になった** (枯渇予兆、UATa §5 #9 教訓)

start.
```

**長文化禁止**。CLI は CLAUDE.md / auto-memory / リポジトリ内ファイルを自分で読みに行く。

---

## 5. 失敗パターン回避 (UATa 21 件 + R2C 5 件 = 26 件)

### 5.1 UATa から引き継ぐ 21 件

UATa 2026-05-19 1日実体験生記録 §4.21 で記録された **claude.ai 推測ミス 21 件**:

| # | 失敗 | 教訓 |
|---|---|---|
| 1 | tmux 提案 (公式機能の見落とし) | 公式 doc/issue を必ず先確認 |
| 2 | cron 環境 Keychain 問題未確認 | 環境固有設定は実機確認 |
| 3 | acceptEdits 仕様未確認 | Edit/Write のみ自動、Bash は止まる |
| 4 | Agent View dispatch input が permission_mode を渡さない仕様未確認 | 公式仕様精読 |
| 5 | 新スレッド = 別人格を失念 | session 開始時に context 明示 |
| 6 | 長文 Lane プロンプト作成 | CLI は CLAUDE.md/auto-memory を読む、claude.ai が repeat 不要 |
| 7 | dev VPS と Mac の secrets を混同 | ホスト別に grep + scp |
| 8 | 過去スレッド確認可能性を未確認で「持ってない」断定 | conversation_search を試す |
| 9 | 「VPS だから stuck」推測即否定 | 実機調査が先 |
| 10 | settings.json `defaultMode` 配置場所誤り | root 直下無効、`permissions.defaultMode` ネスト |
| 11 | Bypass Permissions 警告画面の session 再起動を未確認 | 公式 doc 精読 |
| 12 | 「Don't Ask」を `bypassPermissions` と推測 | 公式 valid values 5 種を確認 |
| 13 | 「VPS に設定済み」を実機未検証 | ssh + ls + cat で実機確認 |
| 14 | 「userMemories」と造語 | 公式機能名「プロジェクトの手順 = Custom instructions」 |
| 15 | 法務無視ルール忘れ | 重要ルールは session 開始時に再読 |
| 16 | 長文継続 | プロンプトは短く、CLI に任せる |
| 17 | 長時間 deploy 経路未確認 | deploy 経路の事前 dry-run |
| 18 | scope 拡大 | 単一タスクに集中 |
| 19 | 別スレッドからの依頼に推測回答 | 過去 context 確認 |
| 20 | 24h を時間量と誤解 | 24h = 連続稼働の意味 |
| 21 | Lane への指示遅延 | 並列化を session 開始時に提案 |

### 5.2 R2C 固有の追加 5 件 (2026-05-19 セッション実証)

| # | 失敗 | 教訓 |
|---|---|---|
| **R2C-1** | メモリ#29 の `/codex:review` 記述を盲信して操作 (実は R2C は旧 plugin 継続、code-review は他プロジェクトのみ) | **メモリは過去のスナップショット。重要操作前は現状確認 (view, ls, gh, git status) が必須** |
| **R2C-2** | `memory_user_edits replace` 前に `view` せず、別エントリ (Phase70 GID 群) を上書き | **`replace` 操作前に必ず `view` を実行** |
| **R2C-3** | Codex Round 1〜8 で**論理ブロックすり抜けが 7 回再現**: SSH host bypass → DELETE fallback → restore lossy → strip 順序 → コマンド置換 → GET response 変換 | **論理ブロック実装は deny-by-default + Codex Round 深化前提で設計**、Round 1 から fail-closed 適用 |
| **R2C-4** | 推測ベースで docs (PHASE69_2_API_SPEC.md) を Claude.ai 単独作成 → CLI 実装照合で 15 項目超の乖離 | **外部共有用 docs は必ず CLI に実装ファイル調査させてから書く** (メモリ#29 docs 作成の鉄則) |
| **R2C-5** | 並列化提案を session 開始時に出せず、70-A 完了後 hkobayashi 指摘で気付き直列モードから切替 | **session 開始時にタスク並列化可能性をマトリクス化、独立して並走可能なタスクは初手から並列提案** |

### 5.3 **【v1.1 強化】 「3 回ルール」資格喪失 — 明文化**

UATa PR #246 で確立、本プロジェクトでも採用 (UATa §5 #5 + R2C 今日 R2C-1〜5 で 5 回中 3 つは同系統):

**同じ系統のミスを 3 回繰り返したら、その種の判断は人間 (hkobayashi) が引き取る。**

R2C で今朝 (2026-05-19) Claude.ai が既に 3 回以上繰り返した系統:

1. **「推測ベースで現状確認せず書き換え」** (R2C-1, R2C-2, テスト数 1617 vs 1169 の誤判断)
   → **判断停止、必ず実機確認後に提案する**
2. **「メモリ盲信」** (R2C-1 メモリ#29、その他 PR 番号など)
   → **メモリ参照後、対応する実機状態を 1 つ以上確認**
3. **「並列化忘れ」** (R2C-5、UATa §21)
   → **session 開始時のチェックリストに「並列化可能性検討」を必須化** (70-K で docs 化)

### 5.4 R2C への適用方針

**CLAUDE.md に「3 回ルール」セクションを明示追加** (70-K で実施):
- 今日のミスをタイプ別にカウント
- 3 回到達したルールは hkobayashi が引き取る or 別タスク化
- 再開条件: 改善策(ガード/監視)実装完了後

---

## 6. 3 AI クロスチェック (重要決定時、UATa §6)

24h 自走の方針 / 範囲を決めるとき、Claude 単独では推測リスク高い。

実用例 (R2C で実施済):
- 2026-05-19 AM: Phase70 v1.0 → v1.1 改訂 (Claude / Grok / Gemini / ChatGPT)
- 採用 14 件、不採用 3 件、新規 70-I 起票、初回 12h パイロット化
- docs/PHASE70_AI_CROSSCHECK.md v1.2 (517 行) に統合済

24h 自走開始前の最終確認も 3 AI クロスチェックを検討:
- Phase70-H 初回 12h パイロット直前 (必須)
- 70-J/K/L 完了後、72 時間後の起動判断時

---

## 7. Asana / Issue tracker との連携 (UATa §7 を R2C 用に調整)

### 7.1 R2C のタスク記述規約 (70-J で確立済)

**docs/ASANA_TASK_TEMPLATE.md (Phase70-J PR #178 完了済)** 参照。

タスク名:
- 形式: `<種類>: <内容>` (例: `docs: VPS_OPS_GUIDE 更新`)
- 禁止文字: 角括弧 `[]`、チルダ `~`、ドット始まり `.` (MCP tool で失敗要因)
- Tier 表記は description 冒頭に「Tier: A/B/S」形式

description 構成:
- Tier (S/A/B)
- Parent (該当時)
- ## 目的
- ## 背景
- ## DoD (N項目チェックボックス)
- ## 推奨モデル (Opus 4.7 / Sonnet 4.6 / Plan Mode)
- ## 関連
- ## 一切しないこと
- /goal (一行サマリ、Asana Watcher で抽出可能)

「24h-eligible」タグ (GID:1214922984195645) で Tier A も自走可能化。

✅ チェック項目 (70-J 完了):
- [x] docs/ASANA_TASK_TEMPLATE.md 作成
- [x] Phase70-A〜L (12 件) + Phase69-2-B/D/E (3 件) を遡及適用
- [x] 「24h-eligible」タグ運用ルール明文化

### 7.2 **【v1.1 追加】 タスクキュー 30-50 本先積み** (UATa §5 #9 教訓)

UATa 実体験: 夜間 8h 自走で **30-50 タスク消化**、補給不足は Lane 停止に直結。

R2C の現状 (2026-05-19 21:30):
- Phase70 残: 6 件 (70-C/E/F/H/I/K)
- Phase69-2 残: B/D/E
- その他散発: 数件
- **合計: 10 件前後、30-50 本に全く足りない**

70-H パイロット前の必須作業:
- [ ] **Asana タスクの先積み** (Tier B 中心、24h-eligible タグ付与)
- [ ] 候補: docs 改善、ガード追加、テスト追加、refactoring 細分化
- [ ] Risk Scorer (70-F) が判定するための「自走可能 vs 人間レビュー必要」分類整理

### 7.3 Asana プロジェクト GID

主プロジェクト: **RAJIUCE Development** (GID: 1213607637045514)

その他: 必要に応じて R2C_DEVELOPMENT_PLAYBOOK.md §11 参照 (70-K で最新化)。

---

## 8. R2C の 1 日のリズム (UATa §8 を R2C 用に調整)

### Phase70-H 初回 12h パイロット (例):
- 21:00 起動前確認 (本チェックリスト §9 全項目)
- 21:30 24h-mode-on.sh + CLI 起動 (12h 自走開始)
- 21:30〜09:30 自走、4h バッチ起動 (21:30, 01:30, 05:30)
- 09:30 hkobayashi 起床 → 朝のレビュー
- 09:30〜10:30 24h-mode-off.sh + PR 一覧確認 + 朝レビュー (70-C で標準化)
- 10:30〜 通常開発 (Codex 結果確認、merge、deploy)

### Phase70 全完了後の 24h パイロット (2 回目以降):
- 同パターンで 24h、4h バッチ x 6 (~/2回起床確認)

---

## 9. 24h 自走 起動前チェックリスト (R2C 版 16 項目)

**Phase70-H 12h パイロット直前に全項目 ✓ 必須**。1 項目でも × があれば起動しない。

### 物理 / 論理ブロック
1. [ ] `R2C_24H_MODE=1` で deploy_guard が SSH/VPS コマンドを完全 block する実機確認
2. [ ] `$(ssh ...)` / `` `ssh...` `` / `pnpm && ssh` 連結も block されることを実機確認
3. [ ] main への直接 push が branch protection で reject される実機確認
4. [ ] Cloudflare Pages の自動 deploy を手動で **無効化** 済 (deploy hook の停止 or branch 監視解除)
5. [ ] `gh auth status` で write 権限のある PAT が有効

### 通知経路
6. [ ] Slack #r2c (C0AG07HFJTB) への test 投稿成功 (Slack MCP)
7. [ ] `SCRIPTS/notify-slack.sh` の curl fallback test 成功 (PR #179 完了済)

### 環境設定
8. [ ] `.claude/settings.json` の `permissions.defaultMode: bypassPermissions` + `permissions.deny` が正しい (PR #180 完了済)
9. [ ] CLAUDE.md 200 行以下、必須セクション完備 (70-B 完了、143 行)
10. [ ] `.claude/agents/` の主要 agent (gate-runner, cleanup, deploy-checker, test-writer) 稼働確認
11. [ ] `/status` で Bypass Permissions on 表示確認、承認要求出ないか実機確認 (UATa #11 教訓)

### 【v1.1 追加】 VPS リソース確認 (UATa §4.3 教訓)
12. [ ] **VPS のメモリ使用率事前確認** (`ssh root@65.108.159.161 free -m` を 24h-mode-on 前に実行)
13. [ ] **PM2 プロセス状態確認** (`ssh root@... pm2 list` で 3 プロセス稼働中、メモリ余裕あり)
14. [ ] **`docker ps` で本番コンテナ状態確認** (R2C は PM2 中心だが、tools 用 docker があれば)

### タスクキュー (UATa §5 #9 教訓)
15. [ ] Asana RAJIUCE Development (GID:1213607637045514) に **24h-eligible タスクが 10 件以上**ある (枯渇予防)
16. [ ] DB migration 必要タスクが先頭に来ていない (70-D Asana Watcher が除外できる)

---

## 10. 既知の制約 (2026-05 時点、UATa §10 + R2C 追加)

UATa の制約に加えて、R2C 固有:

- **R2C-A**: VPS が本番唯一、staging 環境なし → 論理ブロックに 100% 依存
- **R2C-B**: Admin UI が main merge → CF Pages auto-deploy → 24h 中の main merge 停止が即 deploy 停止に直結
- **R2C-C**: DB migration の VPS 手動実行が前提、CLI 不可
- **R2C-D**: `.wolf/hooks/stop.js` の Node v24 ES module SyntaxError が non-blocking で出続け、ノイズ大、**TCC EPERM に発展**
- **R2C-E**: `code-review` plugin が他プロジェクト導入済だが R2C は未 install、旧 `/codex:review` を継続使用 (70-K 以降で再評価)
- **R2C-F**: worktree 多重運用 (3 worktree 並行) で Codex の HEAD 把握が混乱する事例あり (2026-05-19 AM 経験)

### 【v1.1 追加】 UATa 実体験ベースの追加制約

- **R2C-G**: **deploy 失敗時の即時 docker/PM2 生存確認手順** (UATa §4.1 教訓)
  - UATa: deploy_production.sh 失敗で 8 コンテナ中 7 消失、volume 生存 → `docker compose up -d` で復旧
  - R2C 適用: VPS deploy 失敗時は `pm2 list` + `df -h` + `ls /opt/rajiuce/` を即実行、データ生存確認
- **R2C-H**: **焼き込み grep 必須** (UATa §4.2 Blue/Green 教訓)
  - UATa: deploy --backend-only で Blue/Green コード不整合、nginx upstream 切替で復旧
  - R2C 適用: deploy 後に `ssh root@... cat /opt/rajiuce/dist/server/<該当ファイル> | grep <変更箇所>` で焼き込み確認
- **R2C-I**: **3 回ルール明文化必要** (UATa PR #246 教訓)
  - 同系統失敗 3 回で資格喪失、CLAUDE.md に追加 (70-K)
- **R2C-J**: **VPS メモリ余裕事前確認** (UATa §4.3 教訓)
  - UATa: frontend build OOM (exit 146)、R2C は CF Pages 側ビルドだがバックエンド API/avatar-agent は VPS のメモリを消費
  - 24h 自走中の自然増加に備え事前確認

### 【Phase70-I 追加】 scope 判定・env ファイル管理ルール

- **R2C-K**: **既存依存脆弱性アップグレード = scope 外確定ルール** (Phase70-I, 2026-05-20 朝の PR #183/#184 判定経験)
  - 判定基準: `git log --all --oneline -- pnpm-lock.yaml | head -5` で lockfile 最終更新日を確認
  - Phase 着手日より前に lockfile が更新されている場合、検出脆弱性は **既存バグ = 当該 Phase の scope 外**
  - 対応: SECURITY_SCAN_ALLOWLIST.md に CVE ID を照合し全件一致なら False Positive 判定 → --admin merge 可
  - 別タスク化: 独立 Asana タスク「依存パッケージアップグレード」を起票 (due_on: 2週間以内)
  - allowlist 漏れが 1 件でもあれば --admin merge 中止、hkobayashi 報告

- **R2C-L**: **.env.bak / .env\* 系の git 追跡防止ルール** (Phase70-I, 2026-05-20 朝の security scan WARN 経験)
  - `.gitignore` に `.env.bak` を必須記載 (追加済: Phase70-I PR)
  - `git ls-files | grep -E '\.env'` で追跡状態を確認し、`.env.bak` や `.env.*` が出力されたら即 untrack
  - untrack 手順: `git rm --cached .env.bak && git commit -m "chore: untrack .env.bak"`
  - security scan で `[WARN] .env.bak tracked by git` が出た場合は内容を必ず確認し、本番 API キーが含まれていれば即停止 → hkobayashi 報告
  - ローカル開発値のみ (PORT/localhost/placeholder) なら WARN 止まりとして merge は許可するが、untrack 対応を別タスク化

---

## 11. プロジェクト固有部分 (R2C 適応版、UATa §11 対応)

R2C 適用済の差分:
- §1.1 物理境界 → R2C は論理ブロック 100% 依存
- §1.2 通知先 channel ID → C0AG07HFJTB (Slack #r2c)
- §3.1 HUMAN-REVIEW-REQUIRED → DB migration / .env / 法務関連 / 書籍PDF / VPS 全般
- §4 Phase 1-4 目標 → R2C は 4h バッチ x 3 (12h) または x 6 (24h)
- §7 Asana プロジェクト GID → 1213607637045514
- §8 1 日のリズムの時刻 → hkobayashi の生活リズムに合わせて調整

---

## 12. 改訂履歴

| バージョン | 日付 | 変更内容 | 作成者 |
|---|---|---|---|
| 1.0 | 2026-05-19 13:00 JST | UATa 24h 自走運用テンプレ v1.0 を R2C 用にカスタマイズ。R2C 固有 (staging 無し、CF Pages auto-deploy、論理ブロック 100% 依存) を反映。起動前チェックリストを 12 項目に拡張 (UATa §9 の 8 項目 + R2C 固有 4 項目) | claude.ai |
| **1.1** | **2026-05-19 22:00 JST** | **UATa 1日実体験生記録 v1.0 (2026-05-19 18:00 JST) を反映**: ①§7.2 タスクキュー 30-50 本先積み追加 (UATa §5 #9)、②§9 起動前チェックリスト 12→16 項目に拡張 (VPS メモリ 4 項目追加、UATa §4.3 教訓)、③§5.1 UATa 14 件→21 件に拡張、④§5.3 「3 回ルール」明文化 (UATa PR #246)、⑤§10 R2C-G/H/I/J 4 項目追加 (deploy 失敗時 docker 生存確認 / 焼き込み grep / 3 回ルール / VPS メモリ余裕)。Phase70-A/B/D/J/L 完了状態も反映 (PR #176/#178/#179/#180/#181) | claude.ai |
| **1.1 正式** | **2026-05-20 Phase70-K** | DRAFT マーカー削除・正式版昇格。関連ドキュメント一覧追加 (24H_* 5件相互参照)。§3.4 の PLAYBOOK/SKILL 行数を実機確認値に更新 (PLAYBOOK 654 行 / SKILL 302 行)。CLAUDE.md に「3 回ルール」セクション追加 (PR #182 → Phase70-K PR) | claude code cli |
| **1.2** | **2026-05-20 Phase70-I** | §10 Out of scope 拡張: R2C-K (既存依存脆弱性 scope 外判定ルール) + R2C-L (.env.bak git 追跡防止ルール) 追加。PR #183/#184 の pnpm audit 判定経験を明文化。 | claude code cli |

---

## 13. 次のアクション (本ドキュメントの取り扱い)

1. **hkobayashi レビュー**: 内容に誤認・抜け漏れがあるか確認 (今夜 or 明日)
2. **70-K (PLAYBOOK 整理) で取り込み**: docs/24H_AUTONOMOUS_PLAYBOOK.md と併合 or 相互リンク
3. **CLAUDE.md への「3 回ルール」追加** (70-K で実施、§5.3 の内容を CLAUDE.md にも明記)
4. **70-F (Risk Scorer) との連携**: §7.2 の「自走可能 vs 人間レビュー必要」分類が Risk Scorer の判定基準になる
5. **Phase70-H 12h パイロット直前**: 全 16 項目 ✓ を最終確認、1 項目でも × なら起動延期
6. **タスクキュー 30-50 本先積み**: 70-H 前に Asana 起票作業を別途実施
