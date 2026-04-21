# Phase A: 監視・アラート設定ガイド

## 1. PostHog ダッシュボード設定 (R2C運営用)

### 1-1. LLM Analytics ダッシュボード

PostHog のプロジェクトで以下のインサイトを作成します。

**イベント:** `$ai_generation`

| メトリクス | 設定方法 |
|---|---|
| 月次トークン消費量 | `$ai_input_tokens + $ai_output_tokens` の合計 トレンドチャート |
| 月次推定コスト（USD） | `$ai_cost` の合計 トレンドチャート |
| 平均レイテンシ（秒） | `$ai_latency` の平均 トレンドチャート |
| モデル別内訳 | `$ai_model` でBreakdown |
| テナント別使用量 | `tenant_id` でBreakdown |

**アラート設定（PostHog Alerts）:**
- 月次コスト: `$ai_cost` 合計が $30 を超えたら Slack 通知
- エラー率: `$ai_error` が NULL でないイベントが 10件/日 を超えたら通知

### 1-2. CV発火率ダッシュボード

**イベント:** `cv_macro`（Widget.js から送信）

| メトリクス | 設定 |
|---|---|
| マクロCV発火数 | イベント数 日次トレンド |
| ソース別内訳 | `source` プロパティでBreakdown |
| ランク分布 | `rank` プロパティでBreakdown (A/B/C/D) |
| テナント別CV率 | `tenant_id` でBreakdown + 会話数との比率 |

**DB側クロスチェック:**
```sql
-- ランクD（疑義あり）の急増を検出
SELECT date_trunc('day', created_at), COUNT(*)
FROM conversion_attributions
WHERE rank = 'D'
GROUP BY 1 ORDER BY 1 DESC LIMIT 14;
```

### 1-3. エラー率ダッシュボード

**イベント:** `$exception`（PostHog JS SDK が自動キャプチャ）

| メトリクス | 設定 |
|---|---|
| ウィジェットJSエラー数 | `$exception` イベント数 日次 |
| エラーメッセージ内訳 | `$exception_message` でBreakdown |
| セッション別エラー率 | `session_id` でユニーク割合 |

---

## 2. Cloudflare Workers モニタリング

### 2-1. Analytics Engine でのCron監視

Cloudflare Dashboard → Workers & Pages → `r2c-analytics-worker` → Metrics

確認項目:
- **Requests**: Cron Trigger の発火回数（10分毎 = 144回/日）
- **CPU Time**: 正常範囲 10-50ms/回（健全な状態）
- **Errors**: エラー数が 0 であることを確認

### 2-2. wrangler tail でリアルタイムログ確認

```bash
# ローカルで実行
cd cloudflare-workers/r2c-analytics-worker
npx wrangler tail --format pretty
```

正常時のログ出力例:
```
[ga4HealthCheckCron] checked 0 tenants, 0 errors
[ga4HealthCheckCron] checked 3 tenants, 0 errors
```

異常時のログ出力例:
```
[ga4HealthCheckCron] tenant:xxx error: timeout
[vpsApiClient] /internal/ga4/health-check-all failed: 503
```

### 2-3. Email送信失敗時の確認

Cloudflare Email Routing のログは Cloudflare Dashboard → Email Routing → Logs で確認できます。

VPS 側のログ（`/internal/send-notification` エンドポイント）:
```bash
# VPS での確認
pm2 logs rajiuce-api --lines 100 | grep "send-notification"
```

---

## 3. VPS AlertEngine との連携

### 3-1. Phase A 由来のエラー通知ルート

```
Cloudflare Worker (Cron)
  → GA4 健全性チェック失敗
  → POST /internal/send-notification (HMAC認証)
  → VPS: EmailMessage 送信
  → 担当者メールアドレス (tenant_contact_email)
       + Slack Webhook (SLACK_WEBHOOK_URL)
```

### 3-2. notification_preferences による通知制御

`notification_preferences` テーブルで各テナントの通知ON/OFFを制御:

```sql
-- GA4エラー通知をOFFにする例
UPDATE notification_preferences
SET email_enabled = false
WHERE tenant_id = 'xxx' AND notification_type = 'ga4_error';
```

通知タイプ一覧:
| type | 説明 | デフォルト |
|---|---|---|
| `ga4_error` | GA4接続エラー | メール ON, アプリ内 ON |
| `cv_drop` | CV数急減（前日比50%以上減） | メール ON, アプリ内 ON |
| `llm_cost_spike` | LLMコスト急増（前日比3倍以上） | メール ON, アプリ内 ON |
| `weekly_report` | 週次AI改善レポート | メール ON, アプリ内 ON |

### 3-3. Admin UI 通知ベルとの連携

通知センター（`/v1/admin/notifications`）が Phase A 由来のイベントを受け取ります。
- GA4 接続エラー発生時 → `notifications` テーブルに INSERT
- Admin UI の 🔔 ベルアイコンで未読バッジが表示

### 3-4. Prometheus/Grafana（VPS自己ホスト）

既存の Phase24 メトリクスに Phase A 固有のメトリクスが追加されます:

```
# Phase A メトリクス（将来的に追加予定）
r2c_cv_attributions_total{source, rank, tenant_id}
r2c_llm_cost_usd_total{model, tenant_id}
r2c_ga4_health_check_errors{tenant_id}
```

現状はPostHogでの確認を優先し、Prometheusへのエクスポートは Phase A+ で実装予定。
