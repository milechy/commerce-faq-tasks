# RAJIUCE テスト & デプロイゲート標準フロー

> 全Phaseに適用。Phase44以降、デプロイ前に必ずこのフローを通す。
> CLAUDE.mdに本ドキュメントへのポインタを追加すること。
> 最終更新: 2026-04-04（Phase54教訓反映）

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
Gate 4b: Claude in Chrome ブラウザテスト（UI変更Phase: 必須）
  │  B1-B5 共通テスト + Phase固有テスト
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
  │  ★ UI変更がないPhaseではスキップ可
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

## 6. Gate 4b: Claude in Chrome ブラウザテスト（UI変更Phase: 必須）

`claude --chrome` で実行。git push後、デプロイ前に実施。

### 共通チェック（B1-B5）

- [ ] B1: Super Admin / Client Admin 両方でログイン成功
- [ ] B2: ダッシュボード表示（KPIカード、通知ベル🔔）
- [ ] B3: Client Adminで自テナントのデータのみ見える
- [ ] B4: デモURLでチャットが開く
- [ ] B5: 390px幅でレイアウト崩れなし

### Phase固有チェック（B6以降）

各PhaseのAsanaタスクまたはプロンプトに記載。

Playwright MCPが利用可能な場合、CLIから `Playwright MCPでadmin.r2c.bizにアクセスして全ページの表示を確認して` で自動実行可能。

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

## 9. Gate 6: UI調査（UI変更Phase: 必須・人間）

`claude --chrome` で実施。デプロイ後に確認。

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

## 10. 組み合わせパターン

> ★ Gate 1-3 は @gate-runner で一括実行可能（.claude/agents/gate-runner.md）

| Phase種別 | Gate順序 |
|---|---|
| **UI変更を含むデプロイ（★ Phase54以降の標準）** | Gate 1-2 → Gate 2.5（Codex） → Gate 3 → git push → Gate 4b（Chrome） → デプロイ → Gate 5 + Gate 6 |
| **API追加のみ（UI変更なし）** | Gate 1-2 → Gate 2.5（Codex） → Gate 3 → git push → デプロイ → Gate 5 |
| **typo・ドキュメントのみ** | Gate 1 → git push → デプロイ → Gate 5 |
| **セキュリティ変更** | Gate 1-2 → Gate 2.5（adversarial-review） → Gate 3 → git push → Gate 4b → デプロイ → Gate 5 + Gate 6 |

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
- UI変更がある場合はgit push後に claude --chrome でブラウザテスト（Gate 4b）
- デプロイ後にUI変更がある場合はGate 6（UI調査 U1-U8）も必須
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
