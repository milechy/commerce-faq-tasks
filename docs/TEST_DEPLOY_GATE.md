# RAJIUCE テスト & デプロイゲート標準フロー

> 全Phaseに適用。Phase44以降、デプロイ前に必ずこのフローを通す。
> CLAUDE.mdに本ドキュメントへのポインタを追加すること。

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
Gate 3: ビルド確認（自動）
  │  pnpm build → 成功
  │  cd admin-ui && pnpm build → 成功
  │
  ▼
Gate 4: 手動スモークテスト（人間）
  │  ローカルで起動して主要フローを1回通す
  │
  ▼
デプロイ: bash SCRIPTS/deploy-vps.sh
  │
  ▼
Gate 5: ポストデプロイ確認（人間）
  │  /health OK
  │  Admin UIログイン成功
  │  主要機能のスモークテスト
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
- UI: typecheckのみ必須（e2eは手動Gate 4でカバー）

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

## 4. Gate 3: ビルド確認（必須・自動）

```bash
pnpm build
cd admin-ui && pnpm build
```

ビルドが通ることを確認。deploy-vps.sh 内でもビルドするが、事前に確認しておくとデプロイ時のエラーを防げる。

---

## 5. Gate 4: 手動スモークテスト（推奨・人間）

ローカル環境で主要フローを1回通す。Phase固有のテスト項目はデプロイチェックリストに記載する。

共通スモークテスト:

- [ ] ローカルでサーバー起動 → /health OK
- [ ] Admin UIログイン → ダッシュボード表示
- [ ] 新機能の主要フローを1回実行

Phase固有の追加項目はP2（デプロイタスク）のチェックリストに記載。

---

## 6. デプロイ（厳守）

```bash
bash SCRIPTS/deploy-vps.sh
```

個別コマンド（git pull, pnpm build, pm2 restart）は禁止。

---

## 7. Gate 5: ポストデプロイ確認（必須・人間）

```bash
# API
curl http://65.108.159.161:3100/health

# Admin UI
# ブラウザで http://65.108.159.161:5173/ にアクセス

# エラーログ
ssh root@65.108.159.161 "pm2 logs rajiuce-api --lines 20 --nostream 2>&1 | grep -i error | head -5"
```

エラーがあれば即座にロールバック or 修正。

---

## 8. Claude Codeへの伝達方法

各タスクのプロンプトに以下を追記（または最初に読ませる）:

```
テストルール:
- 実装が完了したら必ず pnpm verify を実行
- 新規APIには最低限テストを書く（正常系1 + 認証エラー1 + バリデーション1）
- 外部APIはモック（Groq, Supabase Storage等）
- セキュリティ関連は全パスカバー
- pnpm verify が通らない限りgit pushしない
```

---

## 9. CLAUDE.mdへの追記内容

以下をCLAUDE.mdの Definition of Done セクションに追記:

```markdown
## Test & Deploy Gate（必須フロー）

実装完了 → pnpm verify → security-scan.sh → pnpm build → deploy-vps.sh → ポストデプロイ確認

詳細: docs/TEST_DEPLOY_GATE.md

Gate通過なしのデプロイは禁止。
```

---

## 10. deploy-vps.sh への統合（将来）

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
