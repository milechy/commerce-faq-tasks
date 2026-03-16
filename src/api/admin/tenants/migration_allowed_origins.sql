-- Phase37: allowed_origins per-tenant origin restriction
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS allowed_origins TEXT[] NOT NULL DEFAULT '{}';
