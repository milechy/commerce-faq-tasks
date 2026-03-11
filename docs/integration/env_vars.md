# 環境変数追加申請
## 使い方
新しい環境変数が必要な場合、ここに追記してください。
統合役が .env / deploy.yml にマージ時に追加します。

## 申請フォーマット
- 変数名: 説明 / デフォルト値 (Stream, Phase番号)

## 申請リスト
（まだなし）

## Phase31 (Stream A)
- SUPER_ADMIN_BYPASS: development環境でSuper Admin認証をバイパス / "true" (Stream A, Phase31)
- SUPABASE_JWT_SECRET: Supabase JWT検証シークレット（既存変数、Phase31で必須化）

DBスキーマ変更: src/api/admin/tenants/migration.sql を実行すること
- 新規テーブル: tenants, tenant_api_keys
