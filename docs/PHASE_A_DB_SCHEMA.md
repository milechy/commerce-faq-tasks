# Phase A DB Schema 設計書

**作成日**: 2026-04-21  
**対象フェーズ**: Phase A Day 1（設計書のみ — SQL実行は Day 2 以降）  
**担当**: Claude Code (Sonnet 4.6)

> **重要**: このファイルは設計書です。SQL Migration の実際の実行は Day 2 に行います。  
> 本番DB に直接 ALTER TABLE を実行しないでください。

---

## 前提: 既存スキーマ確認

`docs/GA4_POSTHOG_PRE_INVESTIGATION.md` の調査結果より:

```sql
-- 既存テーブル (確認済み)
tenants:              id, name, plan, is_active, allowed_origins, system_prompt,
                      billing_enabled, billing_free_from, billing_free_until,
                      lemonslice_agent_id, conversion_types TEXT[], features JSONB,
                      created_at, updated_at

tenant_api_keys:      id UUID, tenant_id, key_hash, key_prefix, is_active,
                      expires_at, last_used_at

behavioral_events:    id UUID, tenant_id, session_id UUID, visitor_id UUID,
                      event_type, event_data JSONB, page_url, referrer, created_at

conversion_attributions: id SERIAL, session_id UUID, tenant_id,
                          psychology_principle_used TEXT[], trigger_type,
                          trigger_rule_id, temp_score_at_conversion NUMERIC,
                          conversion_type, conversion_value NUMERIC,
                          sales_stage_at_conversion, message_count,
                          session_duration_sec, created_at

notifications:        id SERIAL, recipient_role, recipient_tenant_id, type,
                      title, message, link, is_read BOOLEAN, metadata JSONB,
                      created_at
```

---

## A-1. tenants テーブル カラム拡張

### Migration SQL

```sql
-- Migration: add_ga4_posthog_columns_to_tenants
-- 実行タイミング: Day 2 (VPS本番で手動実行)
-- ロールバック: 末尾の ROLLBACK セクション参照

ALTER TABLE tenants
  -- GA4 接続情報
  ADD COLUMN IF NOT EXISTS ga4_property_id         TEXT,
  ADD COLUMN IF NOT EXISTS ga4_status              TEXT
    CHECK (ga4_status IN (
      'not_configured', 'pending', 'connected',
      'error', 'timeout', 'permission_revoked'
    )),
  ADD COLUMN IF NOT EXISTS ga4_invited_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ga4_connected_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ga4_last_sync_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ga4_error_message       TEXT,

  -- テナント連絡先
  ADD COLUMN IF NOT EXISTS tenant_contact_email    TEXT,

  -- PostHog 接続情報 (AES-256 暗号化済み)
  ADD COLUMN IF NOT EXISTS posthog_project_api_key_encrypted TEXT;

-- デフォルト値の設定
UPDATE tenants
  SET ga4_status = 'not_configured'
  WHERE ga4_status IS NULL;

ALTER TABLE tenants
  ALTER COLUMN ga4_status SET DEFAULT 'not_configured';

-- インデックス
CREATE INDEX IF NOT EXISTS idx_tenants_ga4_status
  ON tenants (ga4_status)
  WHERE ga4_status != 'not_configured';
```

### カラム設計補足

| カラム | 型 | 説明 |
|---|---|---|
| `ga4_property_id` | TEXT | GA4 プロパティID (例: `properties/123456789`) |
| `ga4_status` | TEXT (ENUM) | GA4連携ステータス |
| `ga4_invited_at` | TIMESTAMPTZ | パートナーへのGA4招待メール送信日時 |
| `ga4_connected_at` | TIMESTAMPTZ | GA4接続完了日時 |
| `ga4_last_sync_at` | TIMESTAMPTZ | 最終データ同期日時 |
| `ga4_error_message` | TEXT | エラー詳細（`ga4_status = 'error'` 時） |
| `tenant_contact_email` | TEXT | 通知先メールアドレス |
| `posthog_project_api_key_encrypted` | TEXT | PostHog Project API Key (AES-256 暗号化) |

### ga4_status ステートマシン

```
not_configured ──→ pending ──→ connected
                       │           │
                       ↓           ↓
                     error ←── timeout
                       │
                       ↓
              permission_revoked
```

### TenantConfig 型拡張 (TypeScript)

```typescript
// src/lib/tenant-context.ts に追加
interface TenantAnalytics {
  ga4PropertyId?: string;
  ga4Status: 'not_configured' | 'pending' | 'connected' | 'error' | 'timeout' | 'permission_revoked';
  ga4ConnectedAt?: Date;
  posthogEnabled: boolean;
}

// TenantConfig に以下を追加:
// analytics: TenantAnalytics;
// contactEmail?: string;
```

### ロールバック

```sql
-- ロールバック手順 (Day 2 実行前に確認)
ALTER TABLE tenants
  DROP COLUMN IF EXISTS ga4_property_id,
  DROP COLUMN IF EXISTS ga4_status,
  DROP COLUMN IF EXISTS ga4_invited_at,
  DROP COLUMN IF EXISTS ga4_connected_at,
  DROP COLUMN IF EXISTS ga4_last_sync_at,
  DROP COLUMN IF EXISTS ga4_error_message,
  DROP COLUMN IF EXISTS tenant_contact_email,
  DROP COLUMN IF EXISTS posthog_project_api_key_encrypted;

DROP INDEX IF EXISTS idx_tenants_ga4_status;
```

---

## A-2. 新規テーブル設計

### notification_preferences (通知設定)

既存の `notifications` テーブルは通知の格納のみ。テナント別通知設定を追加。

```sql
-- Migration: create_notification_preferences
CREATE TABLE IF NOT EXISTS notification_preferences (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  email_enabled   BOOLEAN DEFAULT true,
  in_app_enabled  BOOLEAN DEFAULT true,
  threshold       JSONB,           -- 閾値設定 (例: {"min_score": 30, "frequency": 5})
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (tenant_id, notification_type)
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_notification_preferences_tenant
  ON notification_preferences (tenant_id);

-- RLS方針: tenant_id = current_tenant_id のみ参照・更新可能
-- super_admin は全レコードにアクセス可
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_preferences_tenant_isolation
  ON notification_preferences
  FOR ALL
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    OR current_setting('app.role', true) = 'super_admin'
  );
```

---

### ga4_connection_logs (GA4連携操作ログ)

GA4連携の全操作を追跡するための監査ログテーブル。

```sql
-- Migration: create_ga4_connection_logs
CREATE TABLE IF NOT EXISTS ga4_connection_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action          TEXT NOT NULL CHECK (action IN (
    'invite_sent',       -- GA4招待メール送信
    'connection_test',   -- 接続テスト実行
    'sync_started',      -- データ同期開始
    'sync_completed',    -- データ同期完了
    'sync_failed',       -- データ同期失敗
    'disconnected',      -- 連携解除
    'permission_check'   -- 権限確認
  )),
  status          TEXT NOT NULL CHECK (status IN ('success', 'failure', 'pending')),
  message         TEXT,
  metadata        JSONB,           -- action固有の追加情報
  triggered_by    TEXT,            -- 'user:{user_id}' | 'cron' | 'webhook'
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- インデックス
CREATE INDEX IF NOT EXISTS idx_ga4_connection_logs_tenant
  ON ga4_connection_logs (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ga4_connection_logs_action
  ON ga4_connection_logs (action, created_at DESC);

-- RLS方針: 操作ログは参照のみ（INSERT はサービス層から）
ALTER TABLE ga4_connection_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY ga4_connection_logs_read
  ON ga4_connection_logs
  FOR SELECT
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    OR current_setting('app.role', true) = 'super_admin'
  );

CREATE POLICY ga4_connection_logs_insert
  ON ga4_connection_logs
  FOR INSERT
  WITH CHECK (true);  -- サービス層での制御に委譲
```

---

### ga4_test_history (接続テスト履歴)

GA4 Measurement Protocol 接続テストの履歴。直近の成否状態を追跡。

```sql
-- Migration: create_ga4_test_history
CREATE TABLE IF NOT EXISTS ga4_test_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  test_type       TEXT NOT NULL CHECK (test_type IN (
    'measurement_protocol',  -- Measurement Protocol 送信テスト
    'data_stream',           -- Data Stream 存在確認
    'realtime',              -- Realtime API 確認
    'admin_api'              -- Admin API アクセス確認
  )),
  success         BOOLEAN NOT NULL,
  response_code   INTEGER,
  response_body   JSONB,
  latency_ms      INTEGER,
  error_message   TEXT,
  tested_at       TIMESTAMPTZ DEFAULT NOW()
);

-- インデックス (直近テスト状態の取得用)
CREATE INDEX IF NOT EXISTS idx_ga4_test_history_tenant_recent
  ON ga4_test_history (tenant_id, tested_at DESC);

-- 古いテスト履歴は自動削除 (90日保持)
-- 実装: Cloudflare Workers Cron または pg_cron で定期削除
-- DELETE FROM ga4_test_history WHERE tested_at < NOW() - INTERVAL '90 days';

-- RLS方針
ALTER TABLE ga4_test_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY ga4_test_history_isolation
  ON ga4_test_history
  FOR ALL
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    OR current_setting('app.role', true) = 'super_admin'
  );
```

---

## A-3. conversion_events 拡張 (Phase65既存テーブル)

### 既存スキーマとの互換性確認

既存 `conversion_attributions` テーブルに以下カラムを追加:

```sql
-- Migration: extend_conversion_attributions_for_dedup
ALTER TABLE conversion_attributions
  -- イベント重複排除用の一意キー
  ADD COLUMN IF NOT EXISTS event_id          UUID UNIQUE,
  -- マクロ/マイクロ CV の区分
  ADD COLUMN IF NOT EXISTS event_type        TEXT
    CHECK (event_type IN ('macro', 'micro'))
    DEFAULT 'macro',
  -- データソース (どこから来たイベントか)
  ADD COLUMN IF NOT EXISTS source            TEXT
    CHECK (source IN ('r2c_db', 'ga4', 'posthog'))
    DEFAULT 'r2c_db',
  -- CV グレード (将来の機械学習用)
  ADD COLUMN IF NOT EXISTS rank              TEXT
    CHECK (rank IN ('A', 'B', 'C', 'D')),
  -- 重複排除完了時刻
  ADD COLUMN IF NOT EXISTS deduplicated_at   TIMESTAMPTZ,
  -- 同一イベントの発火回数 (重複カウント)
  ADD COLUMN IF NOT EXISTS fired_count       INTEGER DEFAULT 1
    CHECK (fired_count >= 1);

-- 既存レコードへのデフォルト値設定
UPDATE conversion_attributions
  SET event_id = gen_random_uuid()
  WHERE event_id IS NULL;

-- event_id を NOT NULL に変更 (既存レコードにUUID付与後)
ALTER TABLE conversion_attributions
  ALTER COLUMN event_id SET NOT NULL;

-- インデックス
CREATE INDEX IF NOT EXISTS idx_conversion_attributions_event_id
  ON conversion_attributions (event_id);

CREATE INDEX IF NOT EXISTS idx_conversion_attributions_source
  ON conversion_attributions (source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversion_attributions_event_type
  ON conversion_attributions (event_type, tenant_id, created_at DESC);
```

### カラム設計補足

| カラム | 型 | 目的 |
|---|---|---|
| `event_id` | UUID UNIQUE NOT NULL | GA4/PostHog のイベントIDと突合する主キー |
| `event_type` | TEXT | `macro`=購入等、`micro`=clarify完了・クリック等 |
| `source` | TEXT | 送信元。重複排除の基準に使用 |
| `rank` | TEXT | A=確定CV、B=高確信度、C=推定、D=不明 |
| `deduplicated_at` | TIMESTAMPTZ | 重複排除処理が完了した日時 |
| `fired_count` | INTEGER | 同一訪問者・同一CVの重複発火数 |

### 互換性について

- 既存の `conversion_type` (`purchase|inquiry|reservation|signup|other`) は **変更しない**
- `event_type` は新カラムで、既存レコードは `'macro'` がデフォルト
- `source='r2c_db'` が既存の R2C 内部データを意味する
- `event_id` は既存レコードには自動で UUID を付与 (Migration SQL 内で実施)

### ロールバック

```sql
ALTER TABLE conversion_attributions
  DROP COLUMN IF EXISTS event_id,
  DROP COLUMN IF EXISTS event_type,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS rank,
  DROP COLUMN IF EXISTS deduplicated_at,
  DROP COLUMN IF EXISTS fired_count;

DROP INDEX IF EXISTS idx_conversion_attributions_event_id;
DROP INDEX IF EXISTS idx_conversion_attributions_source;
DROP INDEX IF EXISTS idx_conversion_attributions_event_type;
```

---

## A-4. Migration 戦略

### 既存 Migration ツールの確認

調査結果より、R2C プロジェクトは専用の Migration フレームワーク (Flyway, Liquibase, Prisma Migrate 等) を使用していない。  
運用方法: **SQL ファイルを VPS で手動実行** (`psql -h ... < migration.sql`)。

参考ファイル:
- `src/api/admin/tenants/migration.sql` — テナントテーブル
- `src/api/admin/tenants/migration_notifications.sql` — 通知テーブル

### Day 2 実行手順

```bash
# 1. VPS SSH接続
ssh root@65.108.159.161

# 2. バックアップ (必須)
pg_dump $DATABASE_URL > /opt/backups/pre_phase_a_$(date +%Y%m%d_%H%M).sql

# 3. Migration 実行
psql $DATABASE_URL < /opt/rajiuce/docs/PHASE_A_DB_SCHEMA.md
# ※ SQLブロックを個別ファイルに抽出して実行すること

# 4. 確認
psql $DATABASE_URL -c "\d tenants"
psql $DATABASE_URL -c "\d notification_preferences"
psql $DATABASE_URL -c "\d ga4_connection_logs"
psql $DATABASE_URL -c "\d ga4_test_history"
psql $DATABASE_URL -c "\d conversion_attributions"
```

### ロールバック手順

```bash
# 新規テーブルを削除 (外部キー依存のため逆順)
psql $DATABASE_URL -c "DROP TABLE IF EXISTS ga4_test_history CASCADE;"
psql $DATABASE_URL -c "DROP TABLE IF EXISTS ga4_connection_logs CASCADE;"
psql $DATABASE_URL -c "DROP TABLE IF EXISTS notification_preferences CASCADE;"

# tenants カラム削除
psql $DATABASE_URL << 'EOF'
ALTER TABLE tenants
  DROP COLUMN IF EXISTS ga4_property_id,
  DROP COLUMN IF EXISTS ga4_status,
  DROP COLUMN IF EXISTS ga4_invited_at,
  DROP COLUMN IF EXISTS ga4_connected_at,
  DROP COLUMN IF EXISTS ga4_last_sync_at,
  DROP COLUMN IF EXISTS ga4_error_message,
  DROP COLUMN IF EXISTS tenant_contact_email,
  DROP COLUMN IF EXISTS posthog_project_api_key_encrypted;
EOF

# conversion_attributions カラム削除
psql $DATABASE_URL << 'EOF'
ALTER TABLE conversion_attributions
  DROP COLUMN IF EXISTS event_id,
  DROP COLUMN IF EXISTS event_type,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS rank,
  DROP COLUMN IF EXISTS deduplicated_at,
  DROP COLUMN IF EXISTS fired_count;
EOF
```

### 本番適用時の注意事項

> **DB migrations are never automatic** — VPS で必ず手動実行・確認すること

1. **カラム追加は後方互換** — `ADD COLUMN IF NOT EXISTS` を使用しているため、既存 API への影響なし
2. **NOT NULL + DEFAULT なし のカラム** — `ga4_property_id` 等は NULL 許容のため既存レコードに影響なし
3. **`event_id` の NOT NULL 化** — 既存レコードに UUID を付与してから `SET NOT NULL` すること（Migration SQL 内で済）
4. **RLS 有効化** — `ENABLE ROW LEVEL SECURITY` は既存クエリに影響する可能性があるため、まずステージング環境で確認
5. **インデックス** — `CREATE INDEX` は `CONCURRENT` オプションで本番ロックを回避することを推奨

---

## テーブル関係図

```
tenants (id PK)
  │
  ├── tenant_api_keys (tenant_id FK)
  ├── notification_preferences (tenant_id FK)
  ├── ga4_connection_logs (tenant_id FK)
  ├── ga4_test_history (tenant_id FK)
  │
  ├── behavioral_events (tenant_id)          ← 既存 (Phase55)
  ├── conversion_attributions (tenant_id)    ← 既存 + 拡張 (Phase58/65/A)
  ├── tuning_rules (tenant_id)               ← 既存 (Phase45)
  └── knowledge_gaps (tenant_id)             ← 既存 (Phase46)
```

---

*設計書作成: Claude Code (Sonnet 4.6) — 2026-04-21*  
*SQL実行: Day 2 予定*
