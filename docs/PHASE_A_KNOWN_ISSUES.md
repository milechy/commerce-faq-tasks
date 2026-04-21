# Phase A: 既知の課題・運用上の注意事項

## 1. GA4 サービスアカウント JSON の運用

### 現状
現在は `GOOGLE_APPLICATION_CREDENTIALS_JSON` 環境変数に JSON を Base64 エンコードして設定しています。
1テナントにつき1サービスアカウントが理想ですが、現状は全テナント共通のサービスアカウントを使用しています。

### 課題
- 複数テナントが同一サービスアカウントを共有している場合、権限が過剰になりうる
- サービスアカウントキーのローテーションが必要になった場合、全テナントに影響
- 1テナントのGA4プロパティへのアクセス失敗が他テナントのデータに影響しない設計だが、鍵管理が一元化されている

### 推奨対応（Phase A+ 以降）
- テナントごとに GA4 サービスアカウントを分離
- `tenants` テーブルに `ga4_credentials_encrypted` カラムを追加
- AES-256-GCM で暗号化して保存（`posthog_api_key_encrypted` と同パターン）

### 暫定対処
- VPS `.env` の `GOOGLE_APPLICATION_CREDENTIALS_JSON` は定期的にローテーション
- サービスアカウントには最小権限（`roles/analytics.viewer`）のみ付与

---

## 2. Cloudflare Workers Paid Plan 課金モニタリング

### 現状
Cloudflare Workers の無料プランは 100,000 リクエスト/日 まで無料。
Cron Trigger（`*/10 * * * *`）= 144回/日、現状は無料枠内。

### 課題
- テナント数が増えると1回のCronで処理するリクエスト数が増加
- Cloudflare Email Routing は無料プランで 100通/日 まで

### 対応方針
- [Cloudflare Dashboard → Billing] で Workers 使用量を月次確認
- Paid プランへの切り替え目安: テナント数 50社以上 または 月間 300万リクエスト超
- Email 通知の代替: Slack Webhook（`SLACK_WEBHOOK_URL`）が既に設定済み

---

## 3. PostHog 無料枠上限への対応

### 現状
PostHog Cloud (EU) の無料枠: 月間 100万イベント / 25万セッション

### イベント消費内訳（1会話あたりの見積もり）
| イベント | 回数 |
|---|---|
| `widget_opened` | 1 |
| `message_sent` | 2-5 |
| `llm_response_received` | 2-5 |
| `$ai_generation` | 2-5 (サーバーサイド) |
| `cv_macro` / `cv_micro` | 0-2 |
| **合計** | **7-18イベント/会話** |

月間 5万会話で最大 90万イベント → 無料枠内。

### 課題と対応
- 月間 10万会話を超えたら有料プランへ切り替え（$450/月〜）
- 代替案: PostHog Self-Hosted（VPSへのインストール、ClickHouse必要）
- 緊急対応: `POSTHOG_PROJECT_API_KEY` を削除すれば即座に全イベント送信停止

---

## 4. Email Sending の送信上限

### Cloudflare Email Routing 制限
- 送信上限: **100通/日**（無料プラン）
- 受信のみ無制限、送信は制限あり

### 在メモリ重複抑制の限界
`ga4HealthCheckHandler.ts` の重複通知抑制は **インメモリ Map** を使用:
```typescript
const lastNotified = new Map<string, number>(); // tenantId → timestamp
const ONE_HOUR = 3600_000;
```
Cloudflare Workers のインスタンスが再起動されるとこの Map はリセットされます。
Workers は通常 30分〜数時間で再起動するため、同じエラーが複数回通知される可能性があります。

### 対応方針（Phase A+ 以降）
- Cloudflare KV に `last_notified:{tenantId}` を保存して永続化
- または VPS 側の `notification_preferences.threshold` に `last_notified` を記録

---

## 5. INTERNAL_API_HMAC_SECRET のローテーション手順

### 概要
Cloudflare Workers → VPS 間の認証に使用する HMAC-SHA256 シークレット。

### ローテーション手順

1. **新しいシークレットを生成:**
   ```bash
   openssl rand -hex 32
   ```

2. **Cloudflare Workers に設定:**
   ```bash
   cd cloudflare-workers/r2c-analytics-worker
   npx wrangler secret put INTERNAL_API_HMAC_SECRET
   # プロンプトで新しいシークレットを入力
   ```

3. **VPS .env を更新:**
   ```bash
   # VPS上で
   nano /path/to/.env
   # INTERNAL_API_HMAC_SECRET=<新しい値>
   pm2 restart rajiuce-api
   ```

4. **動作確認:**
   ```bash
   # wrangler tail でエラーがないか確認
   cd cloudflare-workers/r2c-analytics-worker
   npx wrangler tail --format pretty
   ```

### ローテーション頻度の推奨
- 定期: 6ヶ月毎
- 緊急: シークレットが漏洩した疑いがある場合は即座に

---

## 6. その他の未解決課題

### Phase A Day 7 Part A（本番E2Eテスト）の実施待ち

以下は Claude Code では実行できず、hkobayashi が手動で確認が必要です:
- [ ] `https://api.r2c.biz/widget.js` ロード + PostHog イベント受信確認
- [ ] `$ai_generation` イベントの PostHog LLM Analytics 表示確認
- [ ] Cloudflare Workers Cron の `wrangler tail` ログ確認
- [ ] Admin UI 全タブ（アナリティクス/通知設定/PostHog/GA4）の動作確認

### migration_phase_a.sql の適用状況

VPS での手動SQL実行が必要です（管理者による）:
- `tenant_contact_email` カラム（テナント設定タブに入力欄あり）
- `notification_preferences` テーブル（通知設定タブに使用）
- `conversion_attributions` テーブル（CV重複排除・ランク管理）
