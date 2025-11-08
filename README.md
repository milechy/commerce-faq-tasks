# commerce-faq-tasks# noop
# noop

# Commerce-FAQ SaaS — 開発HQ / タスク管理リポジトリ

このリポジトリは **プロダクト実装コードではなく**、AI FAQサービス *Commerce-FAQ SaaS* の「開発HQ（Docs・ワークフロー・タスク運用）」をまとめるためのリポジトリです。GitHub Issues/Labels/PR を中心に、Notionで定義した各種アーキテクチャ/Runbookを開発の実務に落とし込みます。

---
## ✅ 目的
- タスク管理：GitHub Issues + Labels（`status/prio/type/phase`）で軽量運用
- ドキュメント集約：アーキ・運用・価格/Billing・オンボーディングをここにリンク
- 自動化：`SCRIPTS/` のスクリプトでラベル/起票フローを最短化

---
## 🧭 プロダクト要約（再掲）
- サービス名: **Commerce-FAQ SaaS**
- 目的: AI FAQ + 販促誘導 + 従量課金（固定費ゼロ）
- モデル: Groq GPT-OSS 20B/120B（自動ルーティング）
- 構成: Widget / API / RAG(DB: PostgreSQL+pgvector) / Billing(Stripe) / SendGrid / Datadog & Sentry
- 料金: 従量オンリー（スタンダード×1.5 / カスタム×2.5、初月無料）

---
## 📂 主なドキュメント
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — システム全体像 / 技術構成（Mermaid含む）
- [`REQUIREMENTS.md`](REQUIREMENTS.md) — 追加要件（グローバル展開、モデル、価格、プロンプト圧縮など）
- [`AGENTS.md`](AGENTS.md) — AIエージェント（Claude/Copilot/Codex）向け操作ガイド & gh CLI テンプレ
- [`README_PROJECT.md`](README_PROJECT.md) — GitHub Projects を使うときの運用ノート（※現在は Issues/Labels 中心）
- [`team-members.md`](team-members.md) — メンバー表（GitHub ID ↔ 呼称マップ）

> Notion 側の参照：Billing Architecture / DevOps & QA Runbook / Onboarding Quick Guide / Implementation Checklist など（各ドキュメントからリンク）

---
## 🚦 タスク運用（Issues + Labels）
**必須ラベル**
- `status:*` → `todo` / `in-progress` / `review` / `qa` / `done`
- `prio:*` → `high` / `medium` / `low`
- `type:*` → `feat` / `bug` / `chore` / `ops`
- `phase:*` → `db` / `api` / `ui` / `billing` / `monitoring` / `ci`

**よく使うコマンド**
```bash
# 1) ラベル初期化（必要に応じて）
./SCRIPTS/env_setup.sh

# 2) タスク起票（テンプレ）
gh issue create -R <owner>/<repo> \
  --title "RAGハイブリッド検索のパフォーマンス最適化" \
  --body  $'目的: p95 ≤1.5s維持のためにRAG再ランクを軽量化。\n対象: pgvector + Elasticsearch 統合。\n完了条件: latency<1.5s, TopK=50, Cross-encoder稼働確認。' \
  --label "type:feat,status:todo,prio:high,phase:api" \
  --assignee "@me"

# 3) ステータス変更（例：todo→in-progress）
gh issue edit <N> -R <owner>/<repo> \
  --add-label "status:in-progress" --remove-label "status:todo"

# 4) ブランチ作成→PR作成→自動クローズ（キーワード）
ISSUE=<N>
BR="feat/scope-$ISSUE"
git checkout -b "$BR" && git push -u origin "$BR"
gh pr create -R <owner>/<repo> -B main -H "$BR" \
  -t "feat: scope (Closes #$ISSUE)" -b $'実装詳細...\n\nCloses #'"$ISSUE"
```

> 以前試していた **ProjectのStatus自動更新用Actions** は無効化/削除済み。現状は **ラベル運用に一本化** しています。

---
## 🛠️ スクリプト
- `SCRIPTS/env_setup.sh` … ラベルの一括作成/整合
- `SCRIPTS/gh_workflow_shortcuts.sh` … gh CLI のショートハンド（任意）
- `SCRIPTS/new_task_template.sh` … 新規タスク雛形（任意）

> 実行権限がない場合は `chmod +x SCRIPTS/*.sh` を実行。

---
## 🔐 セキュリティ/運用メモ（抜粋）
- Secrets は **Vault/Cloudflare** 管理（本リポジトリに秘匿情報を置かない）
- Stripe Webhook / Billing同期は **専用サービス** 側で実装、HQでは手順書を管理
- 監視: Datadog/Sentry／パフォーマンスKPI: p95<1.5s, error<1%

---
## 🧪 QA / 出荷前チェック（チェックリスト）
- [ ] Unit/Integration/k6 Pass
- [ ] CrewAI 自動レビュー ≥ 90
- [ ] Stripe サンドボックス請求 OK
- [ ] Cloudflare Rate-limit 動作確認
- [ ] Runbook 更新済み / Rollback 手順確認

---
## 🤝 コントリビューション
1. Issue を作成し、`status:todo` と各種メタラベルを付与
2. ブランチ命名: `feat|bug|chore|ops/<scope>-<issue#>`
3. PR の本文に **Closes #<issue>** を必ず記載
4. マージ後、必要に応じて `status:qa` → `status:done` に手動更新

---
## 📦 開発ツール前提
- Git / GitHub CLI (`gh >= 2.30` 目安)
- Node/PNPM or Python は**このリポジトリでは不要**（アプリ実装は別リポ）

---
## 🧹 .gitignore について
このHQリポジトリでは最低限の `.gitignore` を推奨します（未作成の場合は後述のサンプルを利用）。

```
# .gitignore サンプル
.DS_Store
.env
node_modules/
*.log
.idea/
.vscode/
# ローカル生成物
SCRIPTS/*.local.sh
```

---
## 変更履歴
- 2025-11-08: README を初期化（開発HQとしての正しい説明に更新）