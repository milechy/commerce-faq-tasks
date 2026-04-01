-- Phase52f: コンバージョンタイプのテナントカスタマイズ + chat_sessions outcome記録

-- テナントごとのコンバージョンタイプ定義
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS conversion_types JSONB
  DEFAULT '["購入完了", "予約完了", "問い合わせ送信", "離脱", "不明"]'::jsonb;

-- 会話セッションの結果記録
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS outcome VARCHAR(100);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS outcome_recorded_at TIMESTAMPTZ;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS outcome_recorded_by VARCHAR(255);

-- インデックス: outcome別集計の高速化
CREATE INDEX IF NOT EXISTS idx_chat_sessions_outcome ON chat_sessions (outcome) WHERE outcome IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_outcome_tenant ON chat_sessions (tenant_id, outcome) WHERE outcome IS NOT NULL;
