# GA4 + PostHog 統合 事前調査レポート

**調査日**: 2026-04-21  
**担当**: Claude Code (Sonnet 4.6)  
**対象ブランチ**: `feat/ga4-posthog-pre-investigation`  
**調査方針**: read-only（書き込み操作なし）

---

## 1. テナント関連

### 既存ファイル

| ファイル | 行数 | 概要 |
|---|---|---|
| `src/api/admin/tenants/routes.ts` | ~500行 | CRUD + APIキー発行 + Supabase招待 |
| `src/api/admin/tenants/migration.sql` | - | テーブル定義 |
| `src/api/admin/tenants/apiKeyUtils.ts` | - | SHA-256ハッシュユーティリティ |
| `src/api/admin/tenants/superAdminMiddleware.ts` | 35行 | super_admin ロールガード |
| `src/lib/tenant-context.ts` | 151行 | In-memory TenantConfig ストア |

### DB Schema (migration.sql より)

```sql
-- tenantsテーブル（確認済みカラム）
tenants:
  id            TEXT PRIMARY KEY
  name          TEXT
  plan          TEXT  -- 'starter' | 'growth' | 'enterprise'
  is_active     BOOLEAN
  created_at    TIMESTAMPTZ
  updated_at    TIMESTAMPTZ

-- routes.ts updateTenantSchema より追加フィールド（ALTER TABLE済み）
  allowed_origins       TEXT[]
  system_prompt         TEXT
  billing_enabled       BOOLEAN
  billing_free_from     TIMESTAMPTZ
  billing_free_until    TIMESTAMPTZ
  lemonslice_agent_id   TEXT
  conversion_types      TEXT[]   -- 最大10件, 各50文字以内 (Phase52f)

-- features JSONB (avatar/voice/rag/deep_research: boolean)

tenant_api_keys:
  id            UUID PRIMARY KEY
  tenant_id     TEXT FK → tenants.id
  key_hash      TEXT UNIQUE     -- SHA-256ハッシュ
  key_prefix    TEXT            -- 表示用プレフィックス
  is_active     BOOLEAN
  expires_at    TIMESTAMPTZ
  last_used_at  TIMESTAMPTZ
```

### TenantConfig 構造 (tenant-context.ts)

```typescript
{
  tenantId: string;
  name: string;
  plan: 'starter' | 'growth' | 'enterprise';
  features: { avatar: boolean; voice: boolean; rag: boolean };
  security: {
    apiKeyHash: string;
    hashAlgorithm: 'sha256';
    allowedOrigins: string[];
    rateLimit: number;
    rateLimitWindowMs: number;
  };
  enabled: boolean;
}
```

### Admin UI テナント管理ページ

- `admin-ui/src/pages/admin/tenants/[id].tsx`: **存在しない**
- テナント詳細編集UIは未実装

### GA4/PostHog統合における拡張必要箇所

- `tenants` テーブルに `ga4_measurement_id`, `posthog_api_key` カラム追加が必要
- `TenantConfig` 型にアナリティクス設定フィールドを追加
- Admin UI にテナント別アナリティクス設定画面（`[id].tsx`）を新規作成

---

## 2. 通知システム

### 既存資産

| 資産 | 場所 | 内容 |
|---|---|---|
| notifications.ts | `src/lib/notifications.ts` | 59行。DB INSERT + 重複防止 |
| NotificationBell.tsx | `admin-ui/src/components/common/NotificationBell.tsx` | 30秒ポーリング |
| notifications テーブル | migration_notifications.sql | recipient_role/type/metadata JSONB |
| SSE ストリーム | `src/api/avatar/anamChatStreamRoutes.ts` | avatar 音声会話専用 |

### notifications テーブル

```sql
CREATE TABLE notifications (
  id              SERIAL PRIMARY KEY,
  recipient_role  VARCHAR(50) NOT NULL,   -- 'super_admin' | 'client_admin'
  recipient_tenant_id VARCHAR(100),        -- NULL = broadcast
  type            VARCHAR(50) NOT NULL,
  title           VARCHAR(200),
  message         TEXT,
  link            VARCHAR(500),
  is_read         BOOLEAN DEFAULT false,
  metadata        JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

### 既存 notification type 一覧 (NotificationBell.tsx より)

```
ai_rule_suggested, knowledge_gap_frequent, low_score_alert, avatar_warning,
feedback_received, outcome_recorded, conversion_rate_change, outcome_reminder,
high_conversion_pattern, pdf_processed, option_ordered, option_scheduled,
option_completed, premium_avatar_ordered, premium_avatar_completed, cv_unfired
```

### メール送信機能

- **sendgrid / resend / nodemailer**: package.json に**依存なし**
- ユーザー招待のみ Supabase Admin API (`inviteUserByEmail`) を使用
- GA4/PostHog アラートメールを送る場合は新規にメールライブラリが必要

### SSE実装の有無

- **汎用SSEなし**。avatar音声ストリーミング (`text/event-stream`) のみ
- admin通知は30秒ポーリング（`GET /v1/admin/notifications?is_read=false&limit=5`）
- リアルタイム通知が必要なら SSE エンドポイント新規構築が必要

### 新規構築が必要なもの

| 機能 | 新規 | 備考 |
|---|---|---|
| メール送信 | ○ | Resend 推奨（軽量・無料枠あり） |
| GA4 アラートSSE | △ | 既存ポーリングで代替可能 |
| PostHog webhook受信 | ○ | `/api/posthog/webhook` 新規 |

---

## 3. Supabase Auth

### ロール定義場所と実装

- **定義場所**: Supabase Dashboard `app_metadata.role` フィールド
- **参照場所**: `src/agent/http/authMiddleware.ts` (150+行)
- **ロール種別**: `'super_admin'` / `'client_admin'`

```typescript
// authMiddleware.ts — ロール取得パターン
const role = user.app_metadata?.role || user.user_metadata?.role || user.role;
```

### JWT Payload 構造

```typescript
// Bearer JWT decode結果
payload = {
  sub: "supabase-user-uuid",
  email: "user@example.com",
  app_metadata: {
    role: "super_admin" | "client_admin",
    tenant_id: "tenant-slug"   // ← tenantId はここ
  },
  user_metadata: {
    role: "..."   // フォールバック
  },
  iat: number,
  exp: number
}

// tenantId 取得順序:
req.tenantId = payload.app_metadata?.tenant_id ?? payload.tenant_id ?? "demo";
```

### RBAC実装パターン

```typescript
// superAdminMiddleware.ts
export function superAdminMiddleware(req, res, next) {
  const role = user.app_metadata?.role ?? user.user_metadata?.role;
  if (role !== "super_admin") return res.status(403).json({ error: "forbidden" });
  next();
}

// 一般 JWT 認証 → authMiddleware → tenantContextLoader
// → req.tenantId, req.user が付与される
```

### GA4/PostHog統合への影響

- GA4の `measurement_id` はテナント別 → JWT から tenantId を取得してルックアップ
- PostHog の `api_key` も同様にテナント別管理
- `tenantId` は body から取得禁止（セキュリティポリシー）を厳守

---

## 4. Cron基盤

### 依存関係

| ライブラリ | 状態 |
|---|---|
| node-cron | **なし** |
| bull / bullmq | **なし** |
| agenda | **なし** |

### src/cron/ ディレクトリ

- **存在しない**

### SCRIPTS/ ディレクトリ（主要ファイル）

```
build-widget.sh          — widget.js ビルド
security-scan.sh         — セキュリティスキャン
deploy-vps.sh            — VPSデプロイ（唯一の正式手順）
seed_pg.sh               — PostgreSQL シード
sync-notion.ts           — Notion同期
ocr-pdf-qwen.ts          — PDF OCR
perf_summary.sh          — パフォーマンスベンチマーク集計
perf_agent.sh            — エージェント性能計測
generateTemplateMatrix.ts — テンプレートマトリクス生成
```

### PM2 ecosystem.config.cjs

```javascript
// 現在の常駐プロセス
[
  { name: "rajiuce-api",       script: "dist/src/index.js", port: 3100 },
  { name: "rajiuce-avatar",    script: "avatar-agent/agent.py" },
  { name: "rajiuce-admin",     script: "serve admin-ui/dist -l 5173" },
  { name: "slack-listener",    script: "slack_listener.py" }
]
```

### GA4統合における推奨追加

- **週次レポート送信**: `node-cron` を `src/cron/weeklyReport.ts` に追加
- **PostHog batch export**: 日次バッチ処理として node-cron での実装が適切
- PM2 ecosystem に cron ジョブプロセス追加が必要（またはAPI内インプロセス cron）

---

## 5. Widget基盤

### 現状構造

- **ファイル**: `public/widget.js` (2557行) + `public/widget.min.js`
- **アーキテクチャ**: 1行埋め込み / Shadow DOM / data-api-key + data-tenant 認証

### EventTracker クラス（行2200-2329）

```javascript
EventTracker {
  visitorId:  crypto.randomUUID() → localStorage['r2c_vid']   // 永続
  sessionId:  crypto.randomUUID() → sessionStorage['r2c_sid'] // セッション

  track(eventType, eventData) {
    buffer にイベント追加（タイムスタンプ付き）
  }

  flush() {
    POST /api/events (5秒ごと、50イベント/バッチ)
    payload: { visitor_id, session_id, events[] }
  }
}
```

**自動トラッキングイベント**:
- `page_view`, `scroll_depth` (25/50/75/100%)
- `idle_time` (10/30/60秒)
- `exit_intent`, `product_view` (JSON-LD)

### trackConversion() 実装（行2511-2545）

```javascript
window.r2c.trackConversion = function(conversionType, conversionValue) {
  var payload = {
    visitor_id,
    session_id,
    events: [{
      event_type: 'chat_conversion',
      event_data: {
        conversion_type: conversionType,       // 'purchase'|'inquiry'|'reservation'|'signup'|'other'
        conversion_value: (typeof conversionValue === 'number') ? conversionValue : null
      },
      page_url: location.href,
      referrer: document.referrer
    }]
  };
  fetch(apiBase + '/api/events', { method: 'POST', ... });
}

// 非同期読み込み対応のキュー処理あり (window.r2cQueue)
```

### Event ID生成ロジック

```javascript
// visitor_id (永続)
id = crypto.randomUUID();
localStorage.setItem('r2c_vid', id);

// session_id (セッション)
id = crypto.randomUUID();
sessionStorage.setItem('r2c_sid', id);
```

### TriggerEngine（行2332-2419）

- `trigger_type`: `scroll_depth` / `idle_time` / `exit_intent` / `page_url_match`
- チャット自動オープン + プロアクティブメッセージ
- ルール: `GET /api/trigger-rules` を session storage 5分キャッシュで取得

### GA4/PostHog統合における拡張点

1. **GA4 側送信**: `gtag('event', ...)` を EventTracker の `track()` / `flush()` に追加
2. **PostHog 側送信**: `posthog.capture()` を trackConversion 後に追加
3. **visitor_id の GA4 client_id との対応**: `gtag('get', GA_MEASUREMENT_ID, 'client_id', cb)` で取得してひも付け
4. **Shadow DOM 制限**: GTM の標準スクリプトは Shadow DOM 内では動作しない → widget.js 内部から直接 `window.gtag()` / `window.posthog.capture()` を呼ぶ設計が必要

---

## 6. 本番環境

### PM2 プロセス（2026-04-21 確認）

```
┌──┬──────────────────────┬─────────┬─────────┬──────┬───────┬──────────┐
│id│ name                 │ mode    │ uptime  │ ↺    │status │ mem      │
├──┼──────────────────────┼─────────┼─────────┼──────┼───────┼──────────┤
│ 0│ rajiuce-api          │ fork    │ 41h     │ 406  │online │ 105.8mb  │
│ 5│ rajiuce-avatar       │ fork    │ 40h     │ 229  │online │ 127.0mb  │
│ 6│ rajiuce-sentiment    │ fork    │ 20D     │ 73   │online │ 269.0mb  │
└──┴──────────────────────┴─────────┴─────────┴──────┴───────┴──────────┘

※ rajiuce-admin (serve -l 5173) は起動確認できず → 要確認
※ slack-listener は現在停止中の可能性
```

### 環境変数（GOOGLE_* / POSTHOG_* 系）

```bash
# /opt/rajiuce/.env 確認結果
GOOGLE_* 系: 存在しない
POSTHOG_* 系: 存在しない
GA4_* 系:    存在しない
```

**→ 新規環境変数として追加が必要**:
```bash
GA4_MEASUREMENT_ID=G-XXXXXXXXXX
GA4_API_SECRET=...
POSTHOG_API_KEY=phc_...
POSTHOG_HOST=https://app.posthog.com
```

### Nginx ルーティング（api.r2c.biz）

```nginx
server {
  server_name api.r2c.biz;
  listen 443 ssl;  # Let's Encrypt (certbot)

  location / {
    proxy_pass http://127.0.0.1:3100;  # PM2 rajiuce-api
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;  # WebSocket 対応
    proxy_set_header X-Real-IP $remote_addr;
    client_max_body_size 50M;
    proxy_read_timeout 120s;
  }
}
```

- **PostHog webhook受信エンドポイント**を `/api/posthog/webhook` で追加しても Nginx 設定変更不要（全パスが 3100 へ）
- **GA4 Measurement Protocol** 送信も API サーバー内から直接 HTTPS アウトバウンド → Nginx 経由不要

---

## 7. 既存イベント基盤（参考）

GA4/PostHog 統合の土台として活用できる既存実装：

### behavioral_events テーブル（Phase55）

```sql
CREATE TABLE behavioral_events (
  id          UUID PRIMARY KEY,
  tenant_id   TEXT,
  session_id  UUID,
  visitor_id  UUID,
  event_type  TEXT CHECK (event_type IN (
    'page_view', 'scroll_depth', 'idle_time', 'product_view',
    'exit_intent', 'chat_open', 'chat_message', 'chat_conversion'
  )),
  event_data  JSONB,
  page_url    TEXT,
  referrer    TEXT,
  created_at  TIMESTAMPTZ
);
```

### conversion_attributions テーブル（Phase58/65）

```sql
CREATE TABLE conversion_attributions (
  id                         SERIAL PRIMARY KEY,
  session_id                 UUID,
  tenant_id                  TEXT,
  psychology_principle_used  TEXT[],
  trigger_type               TEXT,
  trigger_rule_id            INTEGER,
  temp_score_at_conversion   NUMERIC,
  conversion_type            TEXT CHECK (conversion_type IN (
    'purchase', 'inquiry', 'reservation', 'signup', 'other'
  )),
  conversion_value           NUMERIC,
  sales_stage_at_conversion  TEXT,
  message_count              INTEGER,
  session_duration_sec       INTEGER,
  created_at                 TIMESTAMPTZ
);
```

### Analytics Routes（既実装）

- `GET /v1/admin/analytics/summary` — セッション/CV集計
- `GET /v1/admin/analytics/trends` — 日次トレンド
- `GET /v1/admin/analytics/conversions` — CV分析

---

## 8. ギャップ分析サマリー

| 項目 | 現状 | GA4統合に必要 | PostHog統合に必要 |
|---|---|---|---|
| テナント別設定 | plan/features のみ | `ga4_measurement_id` カラム追加 | `posthog_api_key` カラム追加 |
| Admin UI 設定画面 | 存在しない | テナント詳細 `[id].tsx` 新規作成 | 同左 |
| widget.js GA4送信 | なし | `gtag()` 呼び出し追加 | `posthog.capture()` 追加 |
| バックエンド送信 | なし | GA4 Measurement Protocol | PostHog API |
| 環境変数 | なし | `GA4_MEASUREMENT_ID`, `GA4_API_SECRET` | `POSTHOG_API_KEY`, `POSTHOG_HOST` |
| Cron | なし | 週次レポート用 node-cron 追加 | PostHog batch export |
| メール | なし | Resend等の追加（オプション） | 同左 |
| PM2 プロセス | 3プロセス | cron プロセス追加（または API内インプロセス） | 同左 |
| Nginx | 変更不要 | — | — |
| SSE / リアルタイム | avatar専用 | ポーリングで代替可 | 同左 |

---

## 9. 実装推奨順序（次フェーズ参考）

1. **DB マイグレーション**: `tenants` に `ga4_measurement_id`, `posthog_api_key` 追加
2. **TenantConfig 型拡張**: `src/lib/tenant-context.ts` に analytics フィールド追加
3. **テナント CRUD 更新**: `routes.ts` の updateTenantSchema に追加
4. **バックエンド送信ユーティリティ**: `src/lib/analytics/ga4Client.ts`, `posthogClient.ts`
5. **イベントフック**: `src/api/events/eventRoutes.ts` から送信トリガー
6. **widget.js 拡張**: `trackConversion()` に gtag/posthog 送信を追加
7. **Admin UI**: テナント設定画面 + アナリティクスダッシュボード
8. **Cron**: 週次レポート + PostHog batch

---

*調査完了: 2026-04-21 by Claude Code (feat/ga4-posthog-pre-investigation)*
