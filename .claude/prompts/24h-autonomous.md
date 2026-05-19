# R2C 24h 自走プロンプト

<!-- 使い方: このファイルの内容をそのまま Claude Code CLI のプロンプトとして貼り付ける -->
<!-- 事前条件: bash SCRIPTS/24h-mode-on.sh 実行済み、Cloudflare Pages 停止済み -->
<!-- docs/24H_AUTONOMOUS_PLAYBOOK.md を必ず通読してから起動すること -->

---

```
dispatch --model sonnet

## 推奨モデル: Sonnet 4.6

<!-- タスクが Opus 4.7 推奨の場合は asana-watcher.sh 取得後に適宜切り替え -->

## 前提(重要・必読)
- 24h 自走モード ON 中 (`~/.r2c-24h-mode` 存在)
- branch protection: main への direct push 禁止
- CLAUDE.md「24h 自走中の禁止操作」Out of scope 10項目 を厳守すること
- docs/24H_AUTONOMOUS_PLAYBOOK.md §7 Slack 通知パターンを参照すること

## タスク: R2C 24h 自走 — {{START_DATE}} 夜間自走

実行期間: ~24h (Phase 0〜4)
Asana Project: RAJIUCE Development (1213607637045514)

---

## Phase 0: 環境整備 (目安 30分)

1. `.wolf/cerebrum.md` を read し Do-Not-Repeat と Key Learnings を確認
2. `~/.claude/projects/.../memory/MEMORY.md` を read して直近の文脈を確認
3. `git status` + `gh pr list` でリポジトリ状態を把握
4. `bash SCRIPTS/24h-mode-on.sh` の実行状態確認 (`~/.r2c-24h-mode` 存在確認)
5. Slack 通知 (開始):
   `bash SCRIPTS/notify-slack.sh "🚀 24h 自走開始: {{START_DATE}} — Phase 0 完了" --color info`

---

## Phase 1: GitHub 最新化 (目安 1〜2h)

1. `gh pr list --state open` で滞留 PR を確認
2. 各 PR のレビュー状況を確認:
   - Gate 2.5 (Codex) 未実行の PR → `/codex:review --base main --background` 実行
   - Codex P0/P1 指摘がある PR → 修正 commit 追加
   - レビュー承認済みで merge 待ちの PR → **merge 禁止 (main merge は人間専権)**
3. Slack 通知 (Phase 完了):
   `bash SCRIPTS/notify-slack.sh "✅ Phase 1 完了: 滞留 PR {{N}}件を処理" --color success`

---

## Phase 2〜3: Asana Watcher 経由でタスク消化 (目安 ～22h)

### タスク取得ループ

```bash
# 次タスクを取得
bash SCRIPTS/asana-watcher.sh --limit 1
```

取得したタスクに対して:
1. Asana GID を確認し `Asana:get_task <GID>` で詳細を読む
2. タスクの Tier と 24h-eligible タグを確認
   - Tier S: **自走禁止** → skip して次タスクへ
   - DB migration 必要: **自走禁止** → skip
3. タスクの `## 推奨モデル` を確認して適切なモデルで実行
4. `docs/templates/` から対応するテンプレートを選択して実行:
   - 機能追加 → `docs/templates/cli-prompt-feature.md`
   - バグ修正 → `docs/templates/cli-prompt-bugfix.md`
   - リファクタ → `docs/templates/cli-prompt-refactor.md`
   - docs 更新 → `docs/templates/cli-prompt-docs.md`
   - 事前調査 → `docs/templates/cli-prompt-investigation.md`
5. PR 作成後に Slack 通知:
   `bash SCRIPTS/notify-slack.sh "✅ PR #N pushed: <title>, ready for Gate 2.5" --color success`
6. 次タスクへ → ループ継続

### 3回ルール
同一タスクで 3回失敗した場合:
1. `bash SCRIPTS/notify-slack.sh "⚠️ Blocker: <タスク名> — 3回失敗でスキップ" --color warning`
2. Asana コメントに状況を投稿
3. 次タスクへ移行 (このタスクはスキップ)

---

## Phase 4: 朝報告 (目安 30分)

1. `gh pr list --state open --label 24h-loop` で夜間生成 PR を一覧表示
2. 作業サマリを作成 (完了タスク数、生成 PR 数、スキップタスク)
3. Slack 通知 (完成宣言):
   `bash SCRIPTS/notify-slack.sh "🌅 24h 自走完了: PR {{N}}件 ready for review — READY-FOR-REVIEW" --color success`
4. `.wolf/memory.md` にセッションサマリを記録 (Read-Only 制限中は MEMORY.md に記録)

---

## R2C 固有 Out of Scope (絶対禁止)

| # | 禁止操作 |
|---|---|
| 1 | VPS (65.108.159.161 / api.r2c.biz) への接続試行 |
| 2 | main branch への merge (PR merge 含む) |
| 3 | DB マイグレーションの自動実行 |
| 4 | .env / secrets / *.key の編集 |
| 5 | git push --force / git reset --hard origin/main |
| 6 | avatar-agent プロセス操作 |
| 7 | Cloudflare Pages の設定変更 |
| 8 | 依存ライブラリのメジャーバージョン変更 |
| 9 | 法務・契約関連ドキュメント編集 |
| 10 | パートナー本番テナント影響操作 |

## Stop Conditions

以下に該当した場合、**即座に作業を停止**して HUMAN-REVIEW-REQUIRED を投稿:

1. Out of Scope 操作を誤って実行しようとした
2. `deploy_guard.py` に BLOCKED された
3. 認証情報 (.env / API key / secret) をコードに含めようとした
4. 同一問題で 5回以上繰り返し失敗した

停止手順:
```bash
bash SCRIPTS/notify-slack.sh "🛑 Stopped: <reason>" --color error
gh api -X POST repos/milechy/commerce-faq-tasks/issues \
  -f title="HUMAN-REVIEW-REQUIRED: <reason>" \
  -f body="24h 自走中に Stop condition が発火しました。詳細: <reason>"
# 以降 Bash tool 呼び出しを一切行わない
```

## Slack 通知ポイント (5箇所)

| # | タイミング | コマンド |
|---|---|---|
| 1 | 自走開始 (Phase 0 完了) | `notify-slack.sh "🚀 24h 自走開始 ..." --color info` |
| 2 | Phase 完了 | `notify-slack.sh "✅ Phase N 完了 ..." --color success` |
| 3 | Blocker 発生 | `notify-slack.sh "⚠️ Blocker: ..." --color warning` |
| 4 | PR 作成 | `notify-slack.sh "✅ PR #N pushed ..." --color success` |
| 5 | 完成宣言 (Phase 4) | `notify-slack.sh "🌅 24h 完了 ... READY-FOR-REVIEW" --color success` |
```
