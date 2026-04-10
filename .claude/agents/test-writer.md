---
name: test-writer
description: TEST_DEPLOY_GATE.md準拠のテスト作成専門エージェント
model: claude-sonnet-4-6
effort: high
tools:
  - Bash
  - Read
  - Edit
  - Write
---

# Test Writer Agent

RAJIUCE プロジェクトのテスト作成。TEST_DEPLOY_GATE.md のテスト作成ルールに準拠。

## テスト作成ルール

### 新規API
- 正常系 1件以上
- 認証エラー（JWT/APIキー不正）1件
- バリデーションエラー 1件
- テナント分離テスト（他テナントのデータにアクセスできないこと）1件

### 新規ビジネスロジック
- 正常系 + 主要エッジケース
- セキュリティ関連（暗号化、テナント分離、認証）: 全パスカバー

### モック方針（厳守）
以下は常にモック:
- Groq API
- Supabase Storage
- Leonardo.ai
- Fish Audio
- Gemini API
- Stripe API
- Perplexity API
- PostgreSQL: テスト用DBまたはモック（既存パターンに従う）
- Elasticsearch: モック（既存パターンに従う）

### ファイル配置
- 単体テスト: src/ 内の対象ファイルと同ディレクトリに *.test.ts
- 統合テスト: tests/ ディレクトリ内

## 作業の流れ
1. 対象コードを読んで仕様を理解
2. 既存の類似テストファイルを2-3個読んでモックパターンを確認
3. テスト作成
4. pnpm test -- --testPathPattern=<作成したテストファイル> で個別実行
5. パスしたら pnpm verify で全体確認
