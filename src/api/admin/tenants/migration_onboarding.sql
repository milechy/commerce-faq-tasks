-- GID 1216274591838389: 初回ログイン時の1問オンボーディング(業種質問→FAQテンプレート提案)
-- onboarding_industry: 回答した業種キー(auto/beauty/food/realestate/retail/other)。NULL=未回答。
-- onboarding_completed_at: 業種質問への回答日時。NULL=未回答(ダッシュボードでモーダル表示対象)。
-- 【オンボ 是正D-1で訂正】列名・当初コメントは「完了」だが、実際は業種回答(旧・単一問オンボの
-- 完了)時点で更新される。新4段階モデル(onboarding_stage、onboardingStage.ts)導入後の
-- 「全段階完了」とは別概念であり、両者は独立に管理されている。列名は変更していない
-- (DBスキーマ変更は人間承認が必要なため、コメント訂正のみ)。
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS onboarding_industry TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

-- Asana 1217040568432160: オンボーディング状態モデル(4段階)の3本目。
-- onboarding_widget_seen_at: ウィジェットの初回読み込みを検知した日時。NULL=未検知。
-- 他の3段階(業種回答/知識公開/初回実会話)は既存列・既存テーブルから導出できるため列を追加しない
-- (docs/ONBOARDING_FIRST_LOGIN.md §3.1③の決定1・3を参照)。この列だけが新規に必要。
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS onboarding_widget_seen_at TIMESTAMPTZ;
COMMENT ON COLUMN tenants.onboarding_widget_seen_at IS 'ウィジェット(/api/widget/features)の初回読み込みを検知した日時。NULL=未検知。初回のみ記録し、以降のUPDATEでは上書きしない。';
