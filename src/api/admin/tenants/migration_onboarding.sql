-- GID 1216274591838389: 初回ログイン時の1問オンボーディング(業種質問→FAQテンプレート提案)
-- onboarding_industry: 回答した業種キー(auto/beauty/food/realestate/retail/other)。NULL=未回答。
-- onboarding_completed_at: オンボーディング完了日時。NULL=未完了(ダッシュボードでモーダル表示対象)。
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS onboarding_industry TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;
