# 環境変数追加申請
## 使い方
新しい環境変数が必要な場合、ここに追記してください。
統合役が .env / deploy.yml にマージ時に追加します。

## 申請フォーマット
- 変数名: 説明 / デフォルト値 (Stream, Phase番号)

## 申請リスト
（まだなし）

## Security Fix: RAG暗号化 (fix/security-rag-excerpt-limit)
- KNOWLEDGE_ENCRYPTION_KEY: faq_embeddings.text 暗号化キー（64文字hex = 256bit AES-256-GCM）
  - 生成方法: `python3 -c "import secrets; print(secrets.token_hex(32))"`
  - 未設定の場合は平文保存のままフォールバック（console.warnを出力）
  - 既存データのマイグレーション: `DATABASE_URL=... KNOWLEDGE_ENCRYPTION_KEY=... tsx SCRIPTS/encrypt-existing-embeddings.ts`

## Phase32 (Stream A)
- STRIPE_SECRET_KEY: Stripe APIシークレットキー（sk_live_xxx / sk_test_xxx） (Stream A, Phase32)
- STRIPE_WEBHOOK_SECRET: Stripe Webhookエンドポイントシークレット（whsec_xxx） (Stream A, Phase32)
- BILLING_PORTAL_RETURN_URL: Stripe Customer Portal からの返遷先URL / "https://example.com" (Stream A, Phase32)

DBスキーマ変更: src/lib/billing/migration.sql を実行すること
- 新規テーブル: stripe_subscriptions, usage_logs, stripe_usage_reports

## Phase31 (Stream A)
- SUPER_ADMIN_BYPASS: development環境でSuper Admin認証をバイパス / "true" (Stream A, Phase31)
- SUPABASE_JWT_SECRET: Supabase JWT検証シークレット（既存変数、Phase31で必須化）

DBスキーマ変更: src/api/admin/tenants/migration.sql を実行すること
- 新規テーブル: tenants, tenant_api_keys
