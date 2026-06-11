-- src/api/conversion/migration_aaas_source.sql
-- AaaS R2C2 連携: conversion_attributions.source に 'aaas_site_change' を追加
-- 仕様書: docs/AaaS_R2C2_MasterSpec_v1.md §7-2 / Asana GID 1215614330355126
--
-- ⚠️ HUMAN-APPROVAL-REQUIRED: 本番適用は手動実行（VPS メンテ時間帯 AM2-4 JST 推奨）
-- ⚠️ 適用前にステージングで確認すること
-- 制約名の事前確認:
--   SELECT conname FROM pg_constraint
--   WHERE conrelid = 'conversion_attributions'::regclass AND conname LIKE '%source%';
-- (source カラムは migration_phase_a.sql A-3 の無名インライン CHECK で追加されているため
--  自動生成名 conversion_attributions_source_check を想定)

ALTER TABLE conversion_attributions
  DROP CONSTRAINT IF EXISTS conversion_attributions_source_check;

ALTER TABLE conversion_attributions
  ADD CONSTRAINT conversion_attributions_source_check
  CHECK (source IN ('r2c_db', 'ga4', 'posthog', 'aaas_site_change'));

-- tenants に AaaS クライアントへのリンクを追加（冪等）
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS aaas_client_id UUID;

-- ============================================================
-- ROLLBACK:
-- ALTER TABLE tenants DROP COLUMN IF EXISTS aaas_client_id;
-- ALTER TABLE conversion_attributions
--   DROP CONSTRAINT IF EXISTS conversion_attributions_source_check;
-- ALTER TABLE conversion_attributions
--   ADD CONSTRAINT conversion_attributions_source_check
--   CHECK (source IN ('r2c_db', 'ga4', 'posthog'));
-- ============================================================
