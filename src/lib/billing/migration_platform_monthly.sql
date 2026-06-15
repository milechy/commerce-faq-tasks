-- プラットフォーム共通月額固定費の按分課金: 冪等性テーブル
-- Supabase / Cloudflare / Hetzner VPS / Elasticsearch 等、全テナントが共有するインフラ費の
-- 合計を当月アクティブな全テナント(billing_enabled=true)で均等割りして Stripe に上乗せする際の
-- 重複防止。アバター専用費(lemonslice/livekit_monthly_charges)とは独立した費目として別テーブルで管理する。
-- 実行: psql 'postgresql://postgres:...@localhost:5432/commerce_faq' -f migration_platform_monthly.sql

CREATE TABLE IF NOT EXISTS platform_monthly_charges (
  tenant_id      TEXT        NOT NULL,
  period_yyyymm  TEXT        NOT NULL,
  amount_jpy     INTEGER     NOT NULL,
  tenant_count   INTEGER     NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, period_yyyymm)
);
