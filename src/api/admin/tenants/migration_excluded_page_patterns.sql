-- ページ単位のウィジェット非表示設定（許可ドメイン内でも特定パスでは出さない）
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS excluded_page_patterns TEXT[] NOT NULL DEFAULT '{}';
