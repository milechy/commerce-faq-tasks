-- Phase6-C: 金額調整履歴テーブル

CREATE TABLE IF NOT EXISTS billing_adjustments (
  id          SERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  amount      INTEGER NOT NULL,          -- JPY（負=割引、正=追加請求）
  reason      TEXT NOT NULL,
  adjusted_by TEXT,                      -- 操作者メール or tenant_id
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_billing_adjustments_tenant ON billing_adjustments(tenant_id);
