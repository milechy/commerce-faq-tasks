# Phase28 Deploy Checklist

VPS: `65.108.159.161` (Hetzner)

## Pre-deploy (ローカル)

- [ ] `pnpm verify` 通過 (typecheck + 154 tests)
- [ ] `pnpm build` 成功
- [ ] `cd admin-ui && pnpm build` 成功
- [ ] `.env.production.example` から `.env` を作成済み
- [ ] `admin-ui/.env.production.example` から `admin-ui/.env.production` を作成済み
- [ ] API キーを `node -e "console.log(require('crypto').randomUUID())"` で生成済み
- [ ] 本番 .env にプレースホルダ残存なし (`grep -E '=(your-|YOUR_|CHANGE_ME|_xxxx|<your-)' .env` → 出力なし)

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
| `src/api/admin/avatar/migration_category_persona.sql` | LemonSliceペルソナスワップ: avatar_configs に category_persona_map(JSONB)追加 | 要適用 |
| `src/lib/sai/migration_sai_tasks.sql` | Sai代行タスクの所有権レジストリ(sai_tasks)新設。get_sai_task_status の越境読み取り・課金誤帰属を止める (PR #755) | ✅ 2026-08-16 |

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

### sai_tasks migration 実行手順 (PR #755)

> **本番適用済み (2026-08-16)。** 以下は再構築時・別環境向けの記録。
> `CREATE TABLE IF NOT EXISTS` なので再実行しても無害だが、通常は不要。
> 適用時の確認結果: `task_id`(PK) / `tenant_id`(NOT NULL) / `tenants(id)` へのFK /
> `idx_sai_tasks_tenant` がいずれも作成済み。

**適用順序: デプロイ → migration。逆にはできない。**
`migration_sai_tasks.sql` は rsync でVPSへ配布されるため、デプロイ前はVPS上にファイルが存在しない。

この順序で安全な理由 — どの瞬間も現状より悪くならないため:

| タイミング | `get_sai_task_status` の挙動 | 状態 |
|---|---|---|
| デプロイ前(現状) | 所有権照合なしで他テナントのタスクを読める | **脆弱** |
| デプロイ後・migration前 | 照合先が無いため全件拒否 (fail-closed) | 安全・機能停止 |
| migration後 | 依頼元テナントのタスクのみ読める | 安全・正常 |

中間状態では進捗照会が「確認できませんでした」を返すのみで、依頼(`request_sai_task`)自体は通る。
できるだけ短く畳むため、デプロイ直後に続けて実行すること。

```bash
# 1. デプロイ (唯一の手順)
bash SCRIPTS/deploy-vps.sh

# 2. バックアップ (必須)
ssh root@65.108.159.161 "pg_dump \$DATABASE_URL > /opt/backups/pre_sai_tasks_\$(date +%Y%m%d_%H%M).sql"

# 3. 適用前の確認 — 既に存在しないこと (存在するなら適用済み。二重実行は不要)
ssh root@65.108.159.161 "psql \$DATABASE_URL -c \"\\d sai_tasks\""

# 4. Migration 実行
ssh root@65.108.159.161 "psql \$DATABASE_URL -f /opt/rajiuce/src/lib/sai/migration_sai_tasks.sql"

# 5. 確認 — task_id(PK) / tenant_id(NOT NULL) / tenants(id)へのFK / インデックスが揃っていること
ssh root@65.108.159.161 "psql \$DATABASE_URL -c \"\\d sai_tasks\""
```

**動作確認**: 管理画面のチャットで代行を1件依頼し、返ってきたタスクIDで進捗照会する。
「確認できませんでした」が消え、状態が表示されれば適用成功。
別テナントのタスクIDを渡すと「見つかりません」になる（「権限がありません」ではない）。

**ロールバック**: 新規テーブルのみで既存テーブルへの変更が無いため、コードを戻せばテーブルは無害な残骸になる。
テーブル自体を消す必要がある場合のみ以下。**コードが新しいままだと進捗照会が全件拒否に戻る**ので、
必ずコードのロールバックとセットで行う。

```bash
ssh root@65.108.159.161 "psql \$DATABASE_URL -c 'DROP TABLE IF EXISTS sai_tasks;'"
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

## Admin UI (Cloudflare Pages) のCDNキャッシュ破損時の対応

`admin.r2c.biz` は Cloudflare Pages 配信であり、`bash SCRIPTS/deploy-vps.sh` では更新されない
（main push → Pages 自動ビルド）。したがって「Admin UI が起動しない」原因が
デプロイ漏れではなくCDNキャッシュ破損（PR #487で実際に発生、`/assets/*.js` の
URLに対しHTMLの中身が誤ってキャッシュされる事故）の場合、VPS側の対処では直らない。

`bash SCRIPTS/post-deploy-smoke.sh` の「Admin UI asset」チェックがこの破損を自動検知する
（`index.html` が参照する `/assets/*.js` の実ボディ先頭が `<` かどうかを見る。
Content-Typeヘッダだけでは検知できない点に注意）。

1. **対象URLの特定**: smoke test の出力、または `curl -s https://admin.r2c.biz | grep -oE '/assets/[A-Za-z0-9_.-]+\.js'` で破損している資産のパスを確認する。
2. **Cloudflareキャッシュパージ**: Cloudflare ダッシュボード（該当ゾーン → Caching → Configuration → Purge Cache）から、特定したURL（`https://admin.r2c.biz/assets/xxxxx.js` 等）を個別パージする。ゾーン全体のパージは他のテナントへの影響が大きいため、まずは対象URLのみに絞る。
3. **再検証**: `bash SCRIPTS/post-deploy-smoke.sh` を再実行し、「Admin UI asset」チェックが ✅ になることを確認する。

なお `admin-ui/index.html` には自動復旧の仕組みが入っており（起動エラー検知時にキャッシュバスター付きで1回だけ再取得を試みる）、多くの場合はユーザー側で自然に復旧する。上記の手順は自動復旧後も破損が継続する場合、またはsmoke testで能動的に検知した場合の人手対応。
