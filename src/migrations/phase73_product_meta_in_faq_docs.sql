-- Phase73: SalesFlow 商品カード同期 — faq_docs に商品メタカラムを追加
-- Asana タスク #4635 (salesflow-product-card-backend)
-- 実行は DBA/人間 が行う（コードは適用済みを前提として実装）
ALTER TABLE faq_docs
  ADD COLUMN IF NOT EXISTS product_image_url TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS product_price     TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS product_cta_url   TEXT DEFAULT NULL;
