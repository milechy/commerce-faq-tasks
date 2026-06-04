# RAJIUCE テスト & デプロイゲート標準フロー

> 全Phaseに適用。Phase44以降、デプロイ前に必ずこのフローを通す。
> CLAUDE.mdに本ドキュメントへのポインタを追加すること。
> 最終更新: 2026-05-31（Playwright MCP 実運用整合 — 接続手順・未接続時hk目視フロー追記）

---

## 1. フロー全体図

```
実装完了
  │
  ▼
Gate 1: pnpm verify（自動）
  │  typecheck → 0 errors
  │  lint → 0 warnings
  │  test → all pass
  │
  ▼
Gate 1.5: dead-code-check（自動）
  │  bash SCRIPTS/dead-code-check.sh
  │  新規ファイル孤立 / 未登録ルート / 循環依存 → 修正必須
  │
  ▼
Gate 1.6: テストカバレッジ判定（自動）
  │  bash SCRIPTS/gate-1.6-coverage-check.sh
  │  ベースラインより 2% 以上低下 → FAIL
  │  ベースライン未設定 → SKIP (初回は --set-baseline で設定)
  │
  ▼
Gate 2: セキュリティスキャン（自動）
  │  bash SCRIPTS/security-scan.sh
  │  High/Critical → デプロイブロック
  │
  ▼
Gate 2.5: Codex コードレビュー（★ git push前に実行）
  │  /codex:review --base main --background
  │  セキュリティ変更時: /codex:adversarial-review
  │  Critical/High指摘 → 修正必須 → Gate 1に戻る
  │
  ▼
Gate 3: ビルド確認（自動）
  │  pnpm build → 成功
  │  cd admin-ui && pnpm build → 成功
  │
  ▼
★ git commit + push（Gate 1-3通過後のみ）
  │
  ▼
Gate 4b: Playwright MCP ブラウザテスト（UI変更Phase: 必須）
  │  B1-B5 共通テスト + Phase固有テスト
  │  未接続/認証壁 → hk 目視フロー
  │  ★ UI変更がないPhaseではスキップ可
  │
  ▼
デプロイ: bash SCRIPTS/deploy-vps.sh
  │  ★ DBマイグレーション必要な場合は先にVPSでSQL実行
  │
  ▼
Gate 5: ポストデプロイ確認（必須）
  │  /health OK + Admin UIログイン成功
  │
  ▼
Gate 6: UI調査（UI変更Phase: 必須）
  │  U1-U8 チェックリスト
  │  未接続/認証壁 → hk 目視フロー
  │  ★ UI変更がないPhaseではスキップ可
  │
  ▼
Gate 8: 統合 smoke（自動・main push 後）
  │  bash SCRIPTS/gate-8-integration-smoke.sh
  │  (GitHub Actions gate-8-post-merge.yml が自動実行)
  │  FAIL → Slack #r2c alert + rollback 検討
  │
  ▼
完了 → Asanaタスク完了 → PHASE_ROADMAP.md更新
```

---

## 2. Gate 1: pnpm verify（必須・自動）

```bash
pnpm verify
```

これは typecheck + lint + test を一括実行するコマンド（既存）。
Claude Codeは実装の最終ステップで必ず `pnpm verify` を実行し、0 errorsを確認してからgit pushする。

### テスト作成ルール

- 新規API: 最低限 正常系1 + 認証エラー1 + バリデーションエラー1
- 新規ビジネスロジック: 正常系 + 主要エッジケース
- セキュリティ関連（暗号化、テナント分離、認証）: 全パスカバー
- UI: typecheckのみ必須（e2eは手動Gate 4bでカバー）

### モック方針

- 外部API（Groq, Supabase Storage, Leonardo.ai, Fish Audio）: 常にモック
- DB（PostgreSQL）: テスト用DBまたはモック（既存パターンに従う）
- Elasticsearch: モック（既存パターンに従う）

---

## 2.6. Gate 1.6: テストカバレッジ判定（自動）

```bash
bash SCRIPTS/gate-1.6-coverage-check.sh
```

実装完了後、毎回実行してカバレッジが低下していないことを確認する。

### 初回ベースライン設定（main ブランチで一度だけ実施）

```bash
bash SCRIPTS/gate-1.6-coverage-check.sh --set-baseline
git add .coverage-baseline
git commit -m "chore: set Gate 1.6 coverage baseline"
```

### 判断基準

- ベースライン未設定 → SKIP（警告のみ、Git 管理外）
- ベースラインより 2% 以上低下 → **FAIL（修正必須）**
- 低下 2% 以内 または 上昇 → PASS

### ベースライン更新タイミング

テスト削除・対象外化で意図的にカバレッジが下がる場合は
`--set-baseline` でベースラインを更新し、その旨をコミットメッセージに記載する。

---

## 3. Gate 2: セキュリティスキャン（必須・自動）

```bash
bash SCRIPTS/security-scan.sh
```

既存のSECURITY_SCAN_POLICY.mdに従う。
High/Critical検出時はデプロイブロック。

AgentShield導入後は以下も追加:

```bash
npx ecc-agentshield scan
```

---

## 3.5. Gate 2.5: Codex コードレビュー（推奨）

⚠️ **重要: Gate 2.5は必ずgit push前に実行すること。**
**push済みの場合、mainとの差分がなくなりレビューが無意味になる。**

```
/codex:review --base main --background
```

結果確認:
```
/codex:result
```

### 運用ルール

- **通常レビュー**: PR前に1回だけ実行（常時OFFで自動ループなし）
- **セキュリティ変更時のみ**: `/codex:adversarial-review --background`
- Critical/High → **修正必須**。Gate 1から再実行
- False positive → スキップ理由をコミットメッセージに記載
- **スキップOK**: typo修正、ドキュメントのみ、CSSのみ、テストコードのみ

---

## 4. Gate 3: ビルド確認（必須・自動）

```bash
pnpm build
cd admin-ui && pnpm build
```

ビルドが通ることを確認。deploy-vps.sh 内でもビルドするが、事前に確認しておくとデプロイ時のエラーを防げる。

---

## 5. git commit + push のタイミング

**Gate 1（verify）・Gate 2（security-scan）・Gate 2.5（Codex review）・Gate 3（build）が全て通過した後にのみ実行する。**

```bash
git add <files>
git commit -m "feat: ..."
git push origin main
```

- Gate 2.5をpush後に実行しても、mainとの差分がなくなり無意味になる
- push前に全Gateを通すことで、レビューが有効な差分に対して機能する

---

## 6. Gate 4b: Playwright MCP ブラウザテスト（UI変更Phase: 必須）

git push後、デプロイ前に実施。

### Playwright MCP 接続手順

Playwright MCP は **デフォルト未接続**。使用前に以下を一度だけ実行する:

```bash
claude mcp add --scope project playwright npx @playwright/mcp@latest
```

接続確認:

```bash
claude mcp list | grep playwright
# 出力例: playwright: npx @playwright/mcp@latest (connected)
```

### 実行方法

**接続済みの場合（CLI から自動実行）:**

```
Playwright MCPを使って https://admin.r2c.biz にアクセスし、B1〜B5の共通チェックと今回のPhase固有チェックを実施して
```

注意: admin.r2c.biz は **Supabase 認証必須**。CLIセッションに認証情報がない場合は hk が認証情報を提供するか、hk 目視に切り替える。

**未接続または認証提供が困難な場合（hk 目視フロー）:**

1. CLI が「Playwright MCP 未接続」または「ログイン画面で停止」を報告
2. hk がブラウザで `https://admin.r2c.biz` を開き、B1〜B5 + Phase固有チェックを直接確認
3. 確認結果を CLI に返してフローを継続

> 実例: Phase69-2-B (PR #248) / Phase69-2-1-B (PR #249) で Gate 4b が hk 目視に回った。  
> Supabase 認証の壁により CLI 単独では完結しないケースが多い。

### 共通チェック（B1-B5）

- [ ] B1: Super Admin / Client Admin 両方でログイン成功
- [ ] B2: ダッシュボード表示（KPIカード、通知ベル🔔）
- [ ] B3: Client Adminで自テナントのデータのみ見える
- [ ] B4: デモURLでチャットが開く
- [ ] B5: 390px幅でレイアウト崩れなし

### Phase固有チェック（B6以降）

各PhaseのAsanaタスクまたはプロンプトに記載。

### スキップ条件

API追加のみ・DBマイグレーションのみ・バックグラウンド処理のみなど、Admin UIに変更がないPhaseではスキップ可。

---

## 7. デプロイ（厳守）

```bash
bash SCRIPTS/deploy-vps.sh
```

個別コマンド（git pull, pnpm build, pm2 restart）は禁止。

DBマイグレーションがある場合は**デプロイ前**にVPSでSQL手動実行:

```bash
ssh root@65.108.159.161 "psql \$DATABASE_URL -c 'ALTER TABLE ...'"
```

---

## 8. Gate 5: ポストデプロイ確認（必須・人間）

```bash
# API
curl https://api.r2c.biz/health

# Admin UI
# ブラウザで https://admin.r2c.biz にアクセス → ログイン確認

# エラーログ
ssh root@65.108.159.161 "pm2 logs rajiuce-api --lines 20 --nostream 2>&1 | grep -i error | head -5"
```

エラーがあれば即座にロールバック or 修正。

---

## 9. Gate 6: UI調査（UI変更Phase: 必須）

デプロイ後に確認。Playwright MCP または hk 目視で実施。

### Playwright MCP の状態確認（Gate 4b と共通）

```bash
claude mcp list | grep playwright
```

- **接続済み**: CLI から自動実行（下記プロンプト参照）
- **未接続**: `claude mcp add --scope project playwright npx @playwright/mcp@latest` で追加してから実行
- **Supabase 認証が壁になる場合**: hk 目視フローへ切り替え（下記参照）

### 実行方法

**接続済みの場合（CLI から自動実行）:**

```
Playwright MCPを使って https://admin.r2c.biz にアクセスし、U1〜U8の共通チェックとPhase固有確認を実施して。
DevToolsのコンソールエラーとネットワークエラーも確認して。
```

**未接続または認証提供が困難な場合（hk 目視フロー）:**

1. CLI が「Playwright MCP 未接続」または「ログイン画面で停止」を報告
2. hk がブラウザで `https://admin.r2c.biz` を開き、U1〜U8 + Phase固有確認を直接実施
3. DevTools でコンソールエラーとネットワークエラーを確認
4. 確認結果を CLI に返してフローを継続

> 実例: Phase69-2-B (PR #248) / Phase69-2-1-B (PR #249) で Gate 6 が hk 目視に回った。  
> Supabase 認証の壁により CLI 単独では完結しないケースが多い。

### 共通チェック（U1-U8）

- [ ] U1: ログインページ表示
- [ ] U2: ダッシュボード表示（コンソールエラーなし）
- [ ] U3: 通知ベル🔔表示
- [ ] U4: 390px モバイル表示
- [ ] U5: Super Admin / Client Admin 権限分離
- [ ] U6: Phase固有機能の動作確認
- [ ] U7: ネットワークエラーなし（DevTools Network）
- [ ] U8: 日本語 / English 切り替え

### スキップ条件

Gate 4bと同様、UI変更がないPhaseではスキップ可。

---

## 9.5. Gate 8: 統合 smoke（自動・main push 後）

> UATa 事例 #11「並列後の統合検証なし」由来 (Phase70-J)

### 目的

複数 PR の並列 merge 後に、統合された状態で主要エンドポイントが正常に動作することを確認する。  
Gate 1-6 は各 PR 単体の品質を担保するが、Gate 8 は **merge 後の統合状態** を検証する。

### 実行タイミング

- **自動**: `.github/workflows/gate-8-post-merge.yml` が main push 時に実行
- **手動**: `bash SCRIPTS/gate-8-integration-smoke.sh`

### チェック内容（3-5 分で完走）

| ステップ | 確認内容 | 期待値 |
|---|---|---|
| A. /health | 基本死活確認 | status=ok |
| B. /health/business | ビジネスロジック健全性 | warnings=0 (未実装時 SKIP) |
| C. /api/chat | chat エンドポイント存在確認 | 200/401/400/405 |
| D. /carnation-demo/ + /widget.js | widget 配信確認 | 200/3xx |
| E. avatar-agent token | auth guard 生存確認 | 401/403 (未実装時 SKIP) |

### 失敗時のアクション

1. GitHub Actions の失敗通知が Slack `#r2c` に届く
2. 失敗項目を確認し、直近 merge した PR との関係を調査
3. 問題 PR の rollback を検討（`gh pr revert <PR番号>`）
4. 修正 PR を作成して再 merge

```bash
# 手動実行
bash SCRIPTS/gate-8-integration-smoke.sh

# 特定環境向け
API_URL=https://staging.r2c.biz bash SCRIPTS/gate-8-integration-smoke.sh
```

### 制約・設計方針

- Playwright / ブラウザは使わない（Gate 4b/6 と区別、軽量化重視）
- VPS 操作なし（GitHub Actions / ローカル smoke のみ）
- 既存 Gate 1-6 / 1.6 とは独立した別系統
- 認証が必要な機能は「エンドポイント存在確認」のみ（API キー不要）

---

## 10. 組み合わせパターン

> ★ Gate 1-3 は @gate-runner で一括実行可能（.claude/agents/gate-runner.md）

| Phase種別 | Gate順序 |
|---|---|
| **UI変更を含むデプロイ（★ Phase54以降の標準）** | Gate 1-2 → Gate 2.5（Codex） → Gate 3 → git push → Gate 4b（Chrome） → デプロイ → Gate 5 + Gate 6 → **Gate 8（自動）** |
| **API追加のみ（UI変更なし）** | Gate 1-2 → Gate 2.5（Codex） → Gate 3 → git push → デプロイ → Gate 5 → **Gate 8（自動）** |
| **typo・ドキュメントのみ** | Gate 1 → git push → デプロイ → Gate 5 → **Gate 8（自動）** |
| **セキュリティ変更** | Gate 1-2 → Gate 2.5（adversarial-review） → Gate 3 → git push → Gate 4b → デプロイ → Gate 5 + Gate 6 → **Gate 8（自動）** |

**UI変更を含むPhaseでは Gate 4b と Gate 6 を絶対にスキップしない。**

---

## 11. Claude Codeへの伝達方法

### @gate-runner による一括実行（推奨）
Gate 1-3は `.claude/agents/gate-runner.md` で定義された @gate-runner エージェントで一括実行可能:

- CLI内で `@gate-runner` と入力するだけで Gate 1 → 1.5 → 2 → 3 を順に実行
- 結果は統一フォーマットで報告される
- Gate 2.5（Codex review）は引き続き人間が手動実行

各タスクのプロンプトに以下を追記（または最初に読ませる）:

```
テストルール:
- 実装が完了したら必ず pnpm verify を実行
- 新規APIには最低限テストを書く（正常系1 + 認証エラー1 + バリデーション1）
- 外部APIはモック（Groq, Supabase Storage等）
- セキュリティ関連は全パスカバー
- Gate 1-3が通るまでgit pushしない
- ★ Gate 2.5（Codex review）はgit push前に実行（push後は差分なしで無意味）
- UI変更がある場合はgit push後に Playwright MCP でブラウザテスト（Gate 4b）
  - 接続確認: `claude mcp list | grep playwright`
  - 未接続時: `claude mcp add --scope project playwright npx @playwright/mcp@latest`
  - Supabase認証壁の場合 → hk目視フローに切り替え（hkに認証提供を依頼）
- デプロイ後にUI変更がある場合はGate 6（UI調査 U1-U8）も必須（同上の接続/目視フロー）
```

---

## 12. CLAUDE.mdへの追記内容

以下をCLAUDE.mdの Test & Deploy Gate セクションに反映:

```markdown
## Test & Deploy Gate（必須フロー）

実装完了 → pnpm verify → security-scan → Codex review（★push前） → build → git push → [Gate 4b: Chrome（UI変更時）] → deploy-vps.sh → Gate 5 → [Gate 6: UI調査（UI変更時）]

詳細: docs/TEST_DEPLOY_GATE.md

Gate通過なしのデプロイは禁止。
```

---

## 13. deploy-vps.sh への統合（将来）

deploy-vps.sh にGate 1-3を自動チェックとして組み込む案:

```bash
#!/bin/bash
# deploy-vps.sh に追加

echo "=== Pre-deploy Gates ==="

echo "Gate 1: pnpm verify..."
pnpm verify || { echo "❌ Gate 1 FAILED"; exit 1; }

echo "Gate 2: Security scan..."
bash SCRIPTS/security-scan.sh || { echo "❌ Gate 2 FAILED"; exit 1; }

echo "Gate 3: Build..."
pnpm build || { echo "❌ Gate 3 FAILED"; exit 1; }
cd admin-ui && pnpm build || { echo "❌ Gate 3 FAILED (admin-ui)"; exit 1; }
cd ..

echo "=== All gates passed. Deploying... ==="
# ... 既存のデプロイ処理 ...
```

これにより `bash SCRIPTS/deploy-vps.sh` 1コマンドでGate 1-3 + デプロイが完結する。
ただし既存スクリプトへの変更なので、別タスクとして実装する。

---

## 14. ツール選定ガイド（カスタムエージェント）

`.claude/agents/` に定義されたプロジェクト固有エージェント:

| エージェント | 用途 | 起動 |
|---|---|---|
| **@gate-runner** | Gate 1〜3一括実行 + フォーマット報告 | Gate全体（.claude/agents/gate-runner.md） |
| **@cleanup** | dead exports削除、any型付け、as any除去 | コード品質改善時 |
| **@deploy-checker** | VPSデプロイ前後チェックリスト | デプロイ前後確認時 |
| **@test-writer** | テスト作成（モック方針・配置ルール準拠） | 新規テスト追加時 |
