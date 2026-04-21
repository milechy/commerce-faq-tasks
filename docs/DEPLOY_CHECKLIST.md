# Phase28 Deploy Checklist

VPS: `65.108.159.161` (Hetzner)

## Pre-deploy (ローカル)

- [ ] `pnpm verify` 通過 (typecheck + 154 tests)
- [ ] `pnpm build` 成功
- [ ] `cd admin-ui && pnpm build` 成功
- [ ] `.env.production.example` から `.env` を作成済み
- [ ] `admin-ui/.env.production.example` から `admin-ui/.env.production` を作成済み
- [ ] API キーを `node -e "console.log(require('crypto').randomUUID())"` で生成済み

## VPS 環境セットアップ (初回のみ)

```bash
# Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# pnpm + PM2 + serve
corepack enable
corepack prepare pnpm@9.15.9 --activate
npm install -g pm2 serve

# ファイアウォール
sudo ufw allow 3100/tcp
sudo ufw allow 5173/tcp

# PM2 ログローテーション
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

## Deploy

```bash
# ローカルから実行
bash SCRIPTS/deploy-vps.sh root@65.108.159.161

# 初回のみ: OS 再起動時の自動復旧
ssh root@65.108.159.161 "pm2 startup && pm2 save"
```

## Post-deploy 確認

### API サーバー

- [ ] `curl http://65.108.159.161:3100/health` → `{"status":"ok"}`
- [ ] `curl http://65.108.159.161:3100/widget.js` → JS ファイル返却
- [ ] `curl -H "X-Internal-Request: 1" http://65.108.159.161:3100/metrics` → Prometheus メトリクス

### Admin UI

- [ ] `http://65.108.159.161:5173/` → ログイン画面表示
- [ ] Supabase JWT でログイン成功
- [ ] `/admin/knowledge` → PDF アップロード画面表示
- [ ] PDF アップロード → OCR 処理 → pgvector 投入

### Widget

- [ ] `carnation-test.html` or パートナーページで widget.js 読み込み成功
- [ ] チャット送信 → レスポンス返却
- [ ] DevTools Network: `x-api-key` ヘッダー送信確認

### PM2 プロセス

- [ ] `pm2 list` → `rajiuce-api` (online), `rajiuce-admin` (online)
- [ ] `pm2 restart all` → 全プロセス正常再起動
- [ ] `pm2 logs rajiuce-api --lines 20` → エラーなし

## 本番 .env テンプレート

```bash
# API サーバー: /opt/rajiuce/.env
PORT=3100
LOG_LEVEL=info
NODE_ENV=production
ES_URL=http://localhost:9200
DATABASE_URL=postgres://postgres:XXXXX@127.0.0.1:5432/faq
HYBRID_TIMEOUT_MS=300
HYBRID_MOCK_ON_FAILURE=0
CE_ENGINE=heuristic
AGENT_API_KEY=<generated-uuid>
API_KEY_TENANT_ID=partner
ALLOWED_ORIGINS=http://65.108.159.161,http://65.108.159.161:5173
PHASE22_MAX_CONFIRM_REPEATS=2
DEFAULT_TENANT_ID=partner
```

```bash
# Admin UI: /opt/rajiuce/admin-ui/.env.production
VITE_API_BASE=http://65.108.159.161:3100
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_ANON_KEY
```

## Widget 埋め込み例

```html
<script src="https://api.r2c.biz/widget.js"
        data-tenant="partner"
        data-api-key="<generated-uuid>"
        async></script>
```

## DBマイグレーション一覧

| ファイル | 内容 | 適用済み |
|---|---|---|
| `src/api/admin/feedback/migration_feedback.sql` | feedback_messages テーブル初期作成 | ✅ |
| `src/api/admin/feedback/migration_feedback_flagged.sql` | flagged_for_improvement カラム追加 + インデックス | 要適用 |
| `src/api/admin/tenants/migration_phase_a.sql` | Phase A Day 2: tenants GA4/PostHog拡張 + notification_preferences + ga4_connection_logs + ga4_test_history + conversion_attributions拡張 | 要適用 |

### Phase A Day 2 migration 実行手順

```bash
# 1. VPS SSH接続
ssh root@65.108.159.161

# 2. バックアップ (必須)
pg_dump $DATABASE_URL > /opt/backups/pre_phase_a_$(date +%Y%m%d_%H%M).sql

# 3. Migration 実行
psql $DATABASE_URL < /opt/rajiuce/src/api/admin/tenants/migration_phase_a.sql

# 4. 確認
psql $DATABASE_URL -c "\d tenants" | grep ga4
psql $DATABASE_URL -c "\d notification_preferences"
psql $DATABASE_URL -c "\d ga4_connection_logs"
psql $DATABASE_URL -c "\d ga4_test_history"
psql $DATABASE_URL -c "\d conversion_attributions" | grep event_id
```

### Phase A Day 2 環境変数追加 (.env)

```bash
# GA4 Data API (サービスアカウントJSON をbase64エンコード)
GOOGLE_APPLICATION_CREDENTIALS_JSON=<base64-encoded-service-account-json>

# Cloudflare Workers → VPS HMAC認証 (Workers側と同じ値を設定)
INTERNAL_API_HMAC_SECRET=<random-256bit-secret>
```

```bash
# VPS で実行:
ssh root@65.108.159.161 "psql \$DATABASE_URL -f /opt/rajiuce/src/api/admin/feedback/migration_feedback_flagged.sql"
```

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| /health が応答しない | `pm2 logs rajiuce-api`, ポート確認 `ss -tlnp \| grep 3100` |
| CORS エラー | `ALLOWED_ORIGINS` に Admin UI のオリジンが含まれているか確認 |
| Admin UI が空白 | `pm2 logs rajiuce-admin`, `/opt/rajiuce/admin-ui/dist/index.html` の存在確認 |
| PDF アップロード失敗 | `/v1/admin/knowledge/pdf` エンドポイントの実装確認 (Phase27) |
| DB 接続エラー | `DATABASE_URL` のポート (5432 vs 5434) を VPS で確認 |
| メモリ不足 | `free -h`, ES ヒープを `ES_JAVA_OPTS=-Xms1g -Xmx1g` に縮小 |
