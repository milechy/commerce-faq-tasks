-- Phase Security Level 3: APIキーのドメインバインド
-- tenant_api_keys テーブルにキー単位の allowed_origins を追加
-- tenants.allowed_origins (Phase37) に加え、より細粒度の制限が可能になる
ALTER TABLE tenant_api_keys ADD COLUMN IF NOT EXISTS allowed_origins TEXT[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN tenant_api_keys.allowed_origins IS '許可するOriginドメインの配列。空=テナント設定に委譲。パターン例: https://example.com, https://*.example.com';
