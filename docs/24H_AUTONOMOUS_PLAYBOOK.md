# 24h 自走 Playbook (Phase70-A 論理層 安全装置)

R2C は dev/staging を持たず本番 VPS (65.108.159.161) のみ。
UATa テンプレ v1.0 §2.1「本番への接続を物理的に閉じる」が適用不能なので、
論理層の多層防御で代替する。

## 関連ドキュメント (24H_* ファイル群)

| ファイル | 役割 |
|---|---|
| **このファイル** `24H_AUTONOMOUS_PLAYBOOK.md` | 論理ブロック安全装置・起動/停止スクリプト・Cloudflare Pages 手動停止手順 |
| `R2C_24H_STARTUP_CHECKLIST.md` | **24h 自走起動前チェックリスト v1.1** — 16 項目全 ✓ が起動条件。UATa 26 件失敗パターン・3 回ルール・タスクキュー管理 |
| `24H_AUTOMATION_R2C_GAP_ANALYSIS.md` | UATa vs R2C ギャップ分析・アカウント分離手順 |
| `24H_AUTOMATION_RUNBOOK_R2C.md` | R2C 24h 自走 初期構築手順書 |
| `24H_LOOP_LEARNING_INTEGRATION.md` | 学習ループ統合仕様 |
| `24H_LOOP_RETRY_AND_NOTIFICATION_SPEC.md` | Lane retry 戦略 (1回目5分/2回目30分/3回目停止) + Pushover priority |

**Phase70-H 起動前は必ず `R2C_24H_STARTUP_CHECKLIST.md` §9 の 16 項目を全て確認すること。**

## 関連 Asana
- Phase70 親: 1214919472827777
- Phase70-A 本タスク: 1214919660483265
- Phase70-H 初回 24h 自走 (利用先): 別途

## 24h 自走中の禁止操作 (Out of Scope 10項目)

24h 自走モード中、Claude Code CLI および全サブエージェントは
以下の操作を **絶対に行ってはならない**。違反検知時は **Slack #r2c に
`HUMAN-REVIEW-REQUIRED` を投稿し、自身を停止する**。

| # | 禁止操作 | 検知/防御 |
|---|---|---|
| 1 | VPS (65.108.159.161 / api.r2c.biz) への一切の接続試行 | deploy_guard.py R2C_24H_MODE |
| 2 | main branch への merge 操作 (PR merge 含む) | GitHub branch protection |
| 3 | DB マイグレーションの自動実行 | 人間手動運用ルール |
| 4 | .env / secrets / *.key の編集 | .claudeignore |
| 5 | git push --force / git reset --hard origin/main | 運用ルール + branch protection |
| 6 | avatar-agent プロセス操作 (start/stop/restart) | deploy_guard.py SSH ブロック |
| 7 | Cloudflare Pages の設定変更 | 手動停止 (本ドキュメント §3) |
| 8 | 依存ライブラリのメジャーバージョン変更 | コードレビュー / Codex |
| 9 | 法務・契約関連ドキュメント編集 (docs/legal/, docs/contracts/ 等) | 運用ルール |
| 10 | パートナー本番テナント (live tenant) 影響操作 | tenantId 検証 + L1-L4 |

各項目に違反した場合の動作:
1. 即座に `gh api -X POST repos/milechy/commerce-faq-tasks/issues -f title="HUMAN-REVIEW-REQUIRED ..."` で Issue 作成
2. `bash SCRIPTS/r2c-slack-notify.sh --text "HUMAN-REVIEW-REQUIRED: <reason>"` 投稿
3. 当該作業を即時停止 (新規 Bash tool 呼び出しを行わない)

## 1. SCRIPTS/24h-mode-on.sh の使い方

```bash
# 通常実行 (実 ON)
bash SCRIPTS/24h-mode-on.sh

# dry-run (副作用なしで実行内容を確認)
bash SCRIPTS/24h-mode-on.sh --dry-run
```

実行内容:
1. GitHub main branch protection を有効化 (PR レビュー 1必須, admin 含む direct push 禁止, status check 必須)
2. リポジトリの `allow_auto_merge=false`
3. 既存 open PR の auto-merge フラグを解除
4. `~/.r2c-24h-mode` (perm 600) に `R2C_24H_MODE=1` と起動時刻を書き込み
5. Slack `#r2c` (C0AG07HFJTB) に「🔒 24h 自走モード ON」通知
6. Cloudflare Pages の手動停止手順を標準出力 (自動化はしない)

冪等性: `~/.r2c-24h-mode` が既存なら何もせず exit 0。

環境変数オーバーライド:
- `GH_REPO` — 対象リポジトリ (default: `milechy/commerce-faq-tasks`)
- `STATUS_CHECKS` — 必須 status checks CSV (default: `Stream Path Check,Security Scan`)
- `R2C_24H_MODE_FILE` — モードファイルパス (default: `~/.r2c-24h-mode`)

## 2. SCRIPTS/24h-mode-off.sh の使い方

```bash
# 通常実行
bash SCRIPTS/24h-mode-off.sh

# dry-run
bash SCRIPTS/24h-mode-off.sh --dry-run
```

実行内容: on.sh の全逆操作。
1. main branch protection 削除
2. `allow_auto_merge=true` 復帰
3. `~/.r2c-24h-mode` 削除
4. Slack 「🔓 24h 自走モード OFF」通知
5. Cloudflare Pages 再開手順を出力

## 3. Cloudflare Pages の手動停止手順

⚠️ wrangler/IaC でコード管理されていないため、自動化対象外。Phase70-H 開始前に必ず手動実施すること。

### 停止 (24h 自走開始時)

1. https://dash.cloudflare.com にログイン (hkobayashi アカウント)
2. 左ペイン: **Workers & Pages**
3. プロジェクト一覧から `admin-r2c` を選択
4. 上部タブ: **Settings**
5. 左サイドバー: **Builds & deployments**
6. **Production branch** セクションの **Pause deployments** トグルを **ON**
7. 確認: Deployments タブで "Pending" が新規発生しないこと

### 再開 (24h 自走終了時)

1-5 まで同手順
6. **Pause deployments** トグルを **OFF**

## 4. 朝のレビューフロー

> 詳細手順・判定マトリクス・チェックリストは **[docs/MORNING_REVIEW_FLOW.md](MORNING_REVIEW_FLOW.md)** を参照（Phase70-C で設計）。

24h 自走完了後 (翌朝、2 時間以内):
1. `bash SCRIPTS/morning-digest.sh` 実行 → Slack #r2c に PR 一覧・リスク・Codex 結果投稿
2. `docs/MORNING_REVIEW_FLOW.md` の判定マトリクスで各 PR を low / medium / high / reject 分類
3. branch protection を一時 OFF せず、PR 個別レビュー → squash merge (`docs/PR_MERGE_RULES.md`)
4. 全 PR 処理完了後、`bash SCRIPTS/24h-mode-off.sh`
5. Cloudflare Pages auto-deploy を再開（CF ダッシュボード手動操作、§3 参照）

## 5. トラブルシュート

### 24h-mode-on.sh が「Already ON」で停止する
→ 期待通り (冪等性)。実際に branch protection が掛かっているか確認:
```
gh api repos/milechy/commerce-faq-tasks/branches/main/protection
```

### gh CLI が admin 権限不足エラー
→ `gh auth status` で scope に `repo` があるか確認。
無ければ `gh auth refresh -s repo,admin:repo` 実行。
それでも失敗するなら GitHub Web UI から手動で branch protection を設定:
- https://github.com/milechy/commerce-faq-tasks/settings/branches

### Slack 通知が来ない
→ `SLACK_WEBHOOK_URL` が `~/.claude-r2c-config/secrets/r2c-loop.env` にあるか確認。
`SCRIPTS/r2c-slack-notify.sh --text "test" --dry-run` で payload 確認。

### deploy_guard.py が 24h-mode を検知しない
→ `R2C_24H_MODE=1` が export されているか、または `~/.r2c-24h-mode` が存在するか確認。
hook 動作確認:
```
echo '{"tool_name":"Bash","tool_input":{"command":"bash SCRIPTS/deploy-vps.sh"}}' | \
  R2C_24H_MODE=1 python3 .claude/hooks/deploy_guard.py
```
→ exit 2 で `BLOCKED (24h-mode)` が出れば正常。

### 緊急で 24h-mode を強制解除したい
1. `rm -f ~/.r2c-24h-mode`
2. `gh api -X DELETE repos/milechy/commerce-faq-tasks/branches/main/protection`
3. `bash SCRIPTS/r2c-slack-notify.sh --text "⚠️ 24h-mode 緊急解除 by hkobayashi"`

## 7. CLI 自走通知パターン (Phase70-L)

### notify-slack.sh の使い方

```bash
# 基本
bash SCRIPTS/notify-slack.sh "<message>" --color <info|success|warning|error>

# dry-run (実際には送信しない)
bash SCRIPTS/notify-slack.sh "<message>" --color info --dry-run

# チャンネル指定 (デフォルト: C0AG07HFJTB = #r2c)
bash SCRIPTS/notify-slack.sh "<message>" --color info --channel C0AG07HFJTB
```

3段フォールバック:
1. `SLACK_BOT_TOKEN` — `chat.postMessage` API (Slack MCP 相当)
2. `SLACK_WEBHOOK_URL_R2C` or `SLACK_WEBHOOK_URL` — Incoming Webhook curl
3. stderr 書き出し + 終了コード 1

### 標準通知パターン (CLI 自走プロンプトに組み込む)

| イベント | コマンド |
|---|---|
| PR 作成完了 | `bash SCRIPTS/notify-slack.sh "✅ PR #N pushed: <title>, ready for Gate 2.5" --color success` |
| Gate 失敗 | `bash SCRIPTS/notify-slack.sh "⚠️ Gate failed at <step>: <error>" --color warning` |
| Stop condition 発火 | `bash SCRIPTS/notify-slack.sh "🛑 Stopped: <reason>" --color error` |
| HUMAN-REVIEW-REQUIRED | `bash SCRIPTS/r2c-slack-notify.sh --text "HUMAN-REVIEW-REQUIRED: <reason>"` |

### Stop 後の通知ループ防止

- `--color error` で送信成功すると `~/.claude-r2c-config/.r2c-notified-stop` が作成される。
- 同ファイルが存在する間、`--color error` の重複投稿は **skip (exit 0)** される。
- `bash SCRIPTS/24h-mode-off.sh` 実行時にこのフラグファイルを削除すること。
- Stop signal が発火したら **新規 Bash tool 呼び出しを一切行わず**、当該作業を即時停止する。

### Slack 通知が来ない場合

`SLACK_BOT_TOKEN` と `SLACK_WEBHOOK_URL_R2C` の両方が `~/.claude-r2c-config/secrets/r2c-loop.env` に設定されているか確認:
```bash
bash SCRIPTS/notify-slack.sh "test" --color info --dry-run
```

## 8. Auto-Memory 確認手順 (Phase70-B)

### auto-memory とは

Claude Code v2.1.143+ の永続メモリ機能。セッション間の学習内容を
`~/.claude/projects/<project-hash>/memory/MEMORY.md` に自動保存する。

24h 自走中は `.wolf/cerebrum.md` / `.wolf/memory.md` への書き込みを禁止し、
auto-memory (`MEMORY.md`) が唯一の学習書き込み先となる（OpenWolf 役割分離）。

### 設定確認コマンド

```bash
# 1. settings.json で有効化を確認
cat .claude/settings.json | grep -A2 autoMemory
# 期待値: "autoMemoryEnabled": true, "cleanupPeriodDays": 99999

# 2. メモリファイルの存在確認
ls ~/.claude/projects/-Users-hkobayashi-Documents-GitHub-commerce-faq-tasks/memory/
# MEMORY.md が存在すること

# 3. Claude Code CLI セッション内で /memory コマンドを実行して内容確認
```

### 24h 自走開始前チェックリスト (auto-memory 関連)

- [ ] `autoMemoryEnabled: true` が `.claude/settings.json` にある
- [ ] `cleanupPeriodDays: 99999` が設定されている (事実上永続)
- [ ] `.wolf/cerebrum.md` が最新状態（自走開始後は Read-Only）
- [ ] `~/.claude/projects/.../memory/MEMORY.md` が存在する

### トラブルシュート

**`/memory` で内容が表示されない**
→ `autoMemoryEnabled` が `true` か確認。セッション再起動で有効化される。

**24h 自走後に `.wolf/cerebrum.md` が書き換わっている**
→ `deploy_guard.py` が `.wolf/cerebrum.md` への Edit をブロックしているか確認:
```bash
echo '{"tool_name":"Edit","tool_input":{"file_path":".wolf/cerebrum.md","old_string":"x","new_string":"y"}}' | \
  R2C_24H_MODE=1 python3 .claude/hooks/deploy_guard.py
```
exit 2 + BLOCKED が出れば正常。出なければ deny リストに追加を検討。

## 6. 設計判断ログ

- **物理停止 NG → 論理多層防御**: dev 環境ないため。
- **branch protection: enforce_admins=true**: admin 自身も誤って push しないため。
- **STATUS_CHECKS デフォルト 2 件のみ**: PR で確実に走る workflow に限定。`perf-gate.yml` は workflow_dispatch のみで実行されないため除外。`Claude PR Review` はタイミングが不安定なため除外。
- **Cloudflare Pages 自動化なし**: wrangler.toml / API token がコード管理されていない。Phase70-H 直前に hkobayashi が手動操作するのが安全。
- **deploy_guard env-var + file 二重判定**: env var が忘れられても、ファイル存在で fail-safe に動作。

---

更新: 2026-05-19 (Phase70-A 初版)
