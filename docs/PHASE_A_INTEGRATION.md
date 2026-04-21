# Phase A: GA4 + PostHog 統合ドキュメント

## 概要

Phase A では GA4 および PostHog との計測統合、LLM Analytics トラッキング、コンバージョンイベント重複排除、Admin UI のタブ充実を実装しました。

---

## 実装サマリー

### Day 1-2: 基盤構築
- `conversion_attributions` テーブル設計・マイグレーション
- Widget.js への計測埋め込み（GA4 `gtag` + イベント送信）
- `POST /api/conversion` エンドポイント実装

### Day 3: Admin UI GA4 Wizard タブ
- テナント詳細ページに GA4 連携ウィザードタブを追加
- GA4 プロパティ ID 入力 → 接続テスト → ステータス表示

### Day 4: Cloudflare Workers Cron + Email 通知
- `r2c-analytics-worker` に Cron Trigger（`*/10 * * * *`）
- GA4 ヘルスチェック定期実行（`/internal/ga4/health-check-all`）
- HMAC-SHA256 認証付き Email 通知ハンドラ
- 1時間インメモリ重複通知抑制

### Day 5: PostHog 統合
- `posthog-node` シングルトンクライアント（`src/lib/posthog/posthogClient.ts`）
- `$ai_generation` LLM Analytics イベント（`llmAnalyticsTracker.ts`）
- コンバージョンイベント重複排除・ランク付け（`eventIdDedupe.ts`）
  - ランク A: 3ソース確認済 / B: 2ソース / C: 1ソース / D: 疑義あり（負値）
- Admin UI PostHog 連携タブ（接続・検証・切断）
- Widget.js PostHog JS SDK 動的ロード

### Day 6: Admin UI タブ充実
- **SettingsTab 拡張**: `tenant_contact_email` フィールド追加
- **アナリティクスサマリータブ** (`/v1/admin/tenants/:id/analytics-summary`)
  - 期間選択（7日/30日/90日）
  - 会話数・CV（マクロ/マイクロ・ソース別）・LLM使用量・アラート
- **請求情報タブ**: プラン・課金状態・無料期間の確認
- **通知設定タブ** (`/v1/admin/tenants/:id/notification-preferences`)
  - GA4エラー・CV急減・LLMコスト急増・週次レポートの ON/OFF

---

## DB テーブル（`migration_phase_a.sql`）

| テーブル | 用途 |
|---|---|
| `conversion_attributions` | CV イベント記録・重複排除・ランク管理 |
| `notification_preferences` | テナント別通知設定 |
| `ga4_connection_logs` | GA4 接続テスト履歴 |

**テナント追加カラム:**
- `tenants.ga4_property_id` — GA4 プロパティ ID
- `tenants.ga4_status` — 接続ステータス
- `tenants.posthog_api_key_encrypted` — AES-256-GCM 暗号化
- `tenants.tenant_contact_email` — 担当者メールアドレス（通知送信先）

---

## 新規エンドポイント一覧

| メソッド | パス | 認証 | 説明 |
|---|---|---|---|
| GET | `/v1/admin/tenants/:id/analytics-summary` | JWT | アナリティクスサマリー取得 |
| GET | `/v1/admin/tenants/:id/notification-preferences` | JWT | 通知設定一覧 |
| PUT | `/v1/admin/tenants/:id/notification-preferences` | JWT | 通知設定 UPSERT |
| POST | `/v1/admin/tenants/:id/posthog/connect` | JWT | PostHog API キー登録 |
| GET | `/v1/admin/tenants/:id/posthog/status` | JWT | PostHog 接続状態 |
| POST | `/v1/admin/tenants/:id/posthog/verify` | JWT | PostHog 接続確認 |
| DELETE | `/v1/admin/tenants/:id/posthog/disconnect` | JWT | PostHog 切断 |
| POST | `/internal/ga4/health-check-all` | HMAC | 全テナント GA4 ヘルスチェック |
| POST | `/internal/send-notification` | HMAC | Cloudflare Worker → メール通知 |

---

## 環境変数（追加分）

```bash
POSTHOG_PROJECT_API_KEY=phc_...          # PostHog サーバーサイドキー
POSTHOG_API_HOST=https://eu.i.posthog.com  # デフォルト: EU エンドポイント
INTERNAL_API_HMAC_SECRET=...             # Cloudflare Worker 認証シークレット
GOOGLE_APPLICATION_CREDENTIALS_JSON=... # GA4 サービスアカウント JSON
```

---

## VPS デプロイ手順

1. `migration_phase_a.sql` を VPS の PostgreSQL で実行
2. `.env` に上記環境変数を追加し PM2 再起動
3. Cloudflare Workers: `wrangler secret put INTERNAL_API_HMAC_SECRET` → `npm run deploy`
4. `bash SCRIPTS/deploy-vps.sh` でアプリをデプロイ
5. `curl https://api.r2c.biz/health` で疎通確認

---

## セキュリティ考慮事項

- PostHog API キーは AES-256-GCM で DB 保存（`src/lib/crypto/textEncrypt.ts`）
- 内部 API (`/internal/*`) は HMAC-SHA256 + ±5分タイムスタンプ検証
- `tenant_contact_email` は JWT テナント ID 照合後のみ更新可能
- コンバージョン値が負の場合は自動でランク D（疑義フラグ）に設定
