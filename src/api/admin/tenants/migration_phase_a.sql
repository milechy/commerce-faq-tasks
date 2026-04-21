-- Phase A Day 2: GA4/PostHog統合 DB Migration
-- 実行日: 2026-04-22 (Day 2)
-- 対象: VPS PostgreSQL (65.108.159.161)
-- 参照: docs/PHASE_A_DB_SCHEMA.md

-- ============================================================
-- A-1: tenants テーブル GA4/PostHog カラム追加
-- ============================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS ga4_property_id              TEXT,
  ADD COLUMN IF NOT EXISTS ga4_status                   TEXT
    CHECK (ga4_status IN (
      'not_configured', 'pending', 'connected',
      'error', 'timeout', 'permission_revoked'
    )),
  ADD COLUMN IF NOT EXISTS ga4_invited_at               TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ga4_connected_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ga4_last_sync_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ga4_error_message            TEXT,
  ADD COLUMN IF NOT EXISTS tenant_contact_email         TEXT,
  ADD COLUMN IF NOT EXISTS posthog_project_api_key_encrypted TEXT;

-- デフォルト値設定
UPDATE tenants
  SET ga4_status = 'not_configured'
  WHERE ga4_status IS NULL;

ALTER TABLE tenants
  ALTER COLUMN ga4_status SET DEFAULT 'not_configured';

CREATE INDEX IF NOT EXISTS idx_tenants_ga4_status
  ON tenants (ga4_status)
  WHERE ga4_status != 'not_configured';

-- ============================================================
-- A-2: notification_preferences テーブル新規作成
-- ============================================================

CREATE TABLE IF NOT EXISTS notification_preferences (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  email_enabled     BOOLEAN DEFAULT true,
  in_app_enabled    BOOLEAN DEFAULT true,
  threshold         JSONB,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (tenant_id, notification_type)
);

CREATE INDEX IF NOT EXISTS idx_notification_preferences_tenant
  ON notification_preferences (tenant_id);

-- ============================================================
-- A-2: ga4_connection_logs テーブル新規作成
-- ============================================================

CREATE TABLE IF NOT EXISTS ga4_connection_logs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action       TEXT NOT NULL CHECK (action IN (
    'invite_sent', 'connection_test', 'sync_started',
    'sync_completed', 'sync_failed', 'disconnected', 'permission_check'
  )),
  status       TEXT NOT NULL CHECK (status IN ('success', 'failure', 'pending')),
  message      TEXT,
  metadata     JSONB,
  triggered_by TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ga4_connection_logs_tenant
  ON ga4_connection_logs (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ga4_connection_logs_action
  ON ga4_connection_logs (action, created_at DESC);

-- ============================================================
-- A-2: ga4_test_history テーブル新規作成
-- ============================================================

CREATE TABLE IF NOT EXISTS ga4_test_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  test_type     TEXT NOT NULL CHECK (test_type IN (
    'measurement_protocol', 'data_stream', 'realtime', 'admin_api'
  )),
  success       BOOLEAN NOT NULL,
  response_code INTEGER,
  response_body JSONB,
  latency_ms    INTEGER,
  error_message TEXT,
  tested_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ga4_test_history_tenant_recent
  ON ga4_test_history (tenant_id, tested_at DESC);

-- ============================================================
-- A-3: conversion_attributions 拡張 (Phase65既存テーブル)
-- ============================================================

ALTER TABLE conversion_attributions
  ADD COLUMN IF NOT EXISTS event_id         UUID,
  ADD COLUMN IF NOT EXISTS event_type       TEXT
    CHECK (event_type IN ('macro', 'micro'))
    DEFAULT 'macro',
  ADD COLUMN IF NOT EXISTS source           TEXT
    CHECK (source IN ('r2c_db', 'ga4', 'posthog'))
    DEFAULT 'r2c_db',
  ADD COLUMN IF NOT EXISTS rank             TEXT
    CHECK (rank IN ('A', 'B', 'C', 'D')),
  ADD COLUMN IF NOT EXISTS deduplicated_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fired_count      INTEGER DEFAULT 1
    CHECK (fired_count >= 1);

-- 既存レコードにUUIDを付与
UPDATE conversion_attributions
  SET event_id = gen_random_uuid()
  WHERE event_id IS NULL;

-- event_id を NOT NULL + UNIQUE に変更
ALTER TABLE conversion_attributions
  ALTER COLUMN event_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversion_attributions_event_id_key'
  ) THEN
    ALTER TABLE conversion_attributions ADD CONSTRAINT conversion_attributions_event_id_key UNIQUE (event_id);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_conversion_attributions_event_id
  ON conversion_attributions (event_id);

CREATE INDEX IF NOT EXISTS idx_conversion_attributions_source
  ON conversion_attributions (source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversion_attributions_event_type
  ON conversion_attributions (event_type, tenant_id, created_at DESC);

-- ============================================================
-- 確認クエリ (実行後に手動実行して確認)
-- ============================================================
-- \d tenants
-- \d notification_preferences
-- \d ga4_connection_logs
-- \d ga4_test_history
-- \d conversion_attributions
