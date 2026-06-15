-- LiveKit (Ship プラン) 月額固定費の按分課金: 冪等性テーブル
-- 月1回・テナント単位で按分額を Stripe に上乗せ請求する際の重複防止。
-- LemonSlice (lemonslice_monthly_charges) とは独立した費目として別テーブルで管理する。
-- 実行: psql 'postgresql://postgres:...@localhost:5432/commerce_faq' -f migration_livekit_monthly.sql

CREATE TABLE IF NOT EXISTS livekit_monthly_charges (
  tenant_id      TEXT        NOT NULL,
  period_yyyymm  TEXT        NOT NULL,
  amount_jpy     INTEGER     NOT NULL,
  tenant_count   INTEGER     NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, period_yyyymm)
);
