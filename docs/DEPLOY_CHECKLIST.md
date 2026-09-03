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

# 認証用の署名鍵。production では両方とも必須（未設定だと起動時に process.exit(1)）。
# 2つは必ず別の値にする — WIDGET_JWT_SECRET で署名するトークンは
# widget.js として公開配布されるため、管理API用の鍵と共用すると
# 公開トークンで管理面に到達できてしまう。
SUPABASE_JWT_SECRET=<supabase-project-jwt-secret>
WIDGET_JWT_SECRET=<別途生成した独立のランダム値>
```

> **⚠️ 新規env `WIDGET_JWT_SECRET` は、デプロイより先に本番 `.env` へ投入すること。**
> production 必須化（`src/config/env.ts` の起動時バリデーション）と同時に入るため、
> 未設定のままデプロイすると**起動時に `exit(1)` → PM2 が再起動ループ → API 全断**になる。
> `SCRIPTS/deploy-vps.sh` は `.env*` を rsync 除外するので、**デプロイでは配布されない**。
> 順序: ① 本番 `.env` に `WIDGET_JWT_SECRET` を追記 → ② `bash SCRIPTS/deploy-vps.sh`。
>
> ```bash
> # 投入（値は環境ごとに生成する）
> ssh root@65.108.159.161 'cd /opt/rajiuce && grep -q "^WIDGET_JWT_SECRET=" .env || echo "WIDGET_JWT_SECRET=$(openssl rand -hex 32)" >> .env'
> # 確認（キー名だけを見る。値は出さない）
> ssh root@65.108.159.161 'cd /opt/rajiuce && grep -c "^WIDGET_JWT_SECRET=." .env'
> ```

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
| `src/api/admin/feedback/migration_feedback_flagged.sql` | flagged_for_improvement カラム追加 + インデックス | ✅ (2026-08-18 実機確認) |
| `src/api/admin/tenants/migration_phase_a.sql` | Phase A Day 2: tenants GA4/PostHog拡張 + notification_preferences + ga4_connection_logs + ga4_test_history + conversion_attributions拡張 | ✅ (2026-08-16 実機確認) |
| `src/api/admin/avatar/migration_category_persona.sql` | LemonSliceペルソナスワップ: avatar_configs に category_persona_map(JSONB)追加 | ✅ (2026-08-16 実機確認) |
| `src/lib/sai/migration_sai_tasks.sql` | Sai代行タスクの所有権レジストリ(sai_tasks)新設。get_sai_task_status の越境読み取り・課金誤帰属を止める (PR #755) | ✅ 2026-08-16 |
| `src/api/admin/tenants/migration_faq_hints.sql` | tenants に faq_question_hint / faq_answer_hint 追加 | ✅ 2026-08-16 |
| `src/api/admin/tenants/migration_onboarding.sql` | tenants に onboarding_industry / onboarding_completed_at / onboarding_widget_seen_at 追加 | ✅ 2026-08-16 |
| `src/api/admin/agent/migration_admin_agent_columns.sql` | tenants に ga4_measurement_id / posthog_host / widget_theme 追加 | ✅ 2026-08-16 |
| `src/api/admin/feedback/migration_admin_feedback_reply.sql` | admin_feedback に返信5列 + 未読返信の部分インデックス | ✅ 2026-08-16 |
| `src/migrations/phase72c_conversation_flow_logs.sql` | conversation_flow_logs テーブル新設 | ✅ 2026-08-16 |
| `src/migrations/phase72a_tenant_settings_history.sql` | tenant_settings_history テーブル新設（設定変更履歴の保存先） | ✅ 2026-08-16 |
| `src/migrations/phase72d_metrics_snapshots.sql` | metrics_snapshots テーブル新設 | ✅ 2026-08-16 |
| `src/api/conversion/migration_aaas_source.sql` | conversion_attributions の source CHECK に aaas_site_change 追加 + tenants.aaas_client_id 追加（Asana GID 1215614330355126） | ✅ (2026-08-16 実機確認) |
| `src/lib/billing/migration_stripe_webhook_events.sql` | stripe_webhook_events テーブル新規作成（Stripe webhook の event.id 冪等化。同一イベント再送での二重処理を防ぐ） | ⬜ 未適用 |
| `src/lib/billing/migration_stripe_webhook_events.sql` | 同ファイル: `completed_at` カラム追加（2状態管理。ハンドラ失敗後の再送で副作用が永久にスキップされる問題の解消）。**テーブル作成分を先に適用済みの環境でも、この列のために再実行が必要** | ⬜ 未適用 |
| `src/migrations/phase75_conversation_evaluations_unique.sql` | 重複評価行の削除 + `UNIQUE(tenant_id, session_id)` 追加。judge の `ON CONFLICT` がターゲット無しで実質no-opだったため同一セッションの評価が重複し、KPI平均が下振れしていた。**★migration → デプロイの順。逆順は評価INSERTが全件失敗** | ⬜ 未適用 |
| `src/migrations/phase75_tuning_rules_unique.sql` | 重複ルールの削除 + `UNIQUE(tenant_id, trigger_pattern)` 追加。同上（`evaluationAnalyzer` がコメントで謳っていた一意性がDB側に無かった）。**★migration → デプロイの順** | ⬜ 未適用 |
| `src/api/admin/knowledge/migration_drop_es_doc_id.sql` | ナレッジ配線是正P4: faq_docs.es_doc_id(常にNULLで一度も埋まらない死列)を削除。コード側の参照は先行PRで除去済み。**適用前に `SELECT COUNT(*) FROM faq_docs WHERE es_doc_id IS NOT NULL;` で0件確認** | ⬜ 未適用 |
| `src/api/admin/knowledge/migration_drop_is_global.sql` | ナレッジ配線是正P19: faq_docs.is_global(読み手も書き手も無い死列。実際のグローバル知識は`tenant_id='global'/'r2c_docs'`)を削除。コード側の参照は本PRで除去済み。**適用前に `SELECT COUNT(*) FROM faq_docs WHERE is_global = true;` で意図しない使用が無いことを確認** | ⬜ 未適用 |
| `src/lib/billing/migration_usage_logs_session_id.sql` | 会話単位の課金: `usage_logs.session_id` 追加(nullable)。**★migration → デプロイの順。逆順は請求バッチが全滅する**(`computeExpectedBilling` の集計SQLが `session_id` を参照するため、未適用のまま配備すると 42703 で `reportUsageToStripe` が例外を投げ、Stripe送信が一切走らなくなる。`usageTracker` 側は 42703 フォールバックで記録だけは残るが、倍率の焼き付けと会話の紐付けは失われる) | ⬜ 未適用 |
| `src/api/admin/tenants/migration_billing_sync_status.sql` | `tenants.billing_sync_status` / `billing_sync_at` 追加(nullable)。プラン変更時のStripe同期結果をテナント自身に焼き付け、リロードを跨いでも「支払い設定が未完了」の案内が残るようにする。未適用でも動作は壊れない(コードはSELECTで列が無ければ`null`扱いにfail-open、書き込みUPDATEは列が無いテーブルへの`SET`で42703になるがcatchしてログのみ・レスポンスには影響しない)ため優先度は中 | ✅ (2026-09-02 実機確認。デプロイ直後に `[subscriptionSync] billing_sync_status の永続化に失敗した` を42703で実際に確認→適用後は再発なし) |
| `src/api/events/migration_behavioral_events_chat_session_id.sql` | 是正0-4(GID 1218086067416577): `behavioral_events.chat_session_id`(widgetのconversationId)追加(nullable) + `(tenant_id, chat_session_id)`インデックス。behavioral_events(r2c_sid)とchat_sessions(conversationId)を結合できるキーを通す。未適用でも動作は壊れない(`eventRoutes.ts`が42703で source列のみ→旧カラムの順にフォールバックする) | ✅ (2026-09-02 実機確認。`\d behavioral_events` で列・`idx_behavioral_events_chat_session_id` の存在を確認) |
| `src/api/admin/tenants/migration_excluded_page_patterns.sql` | 許可ドメイン内でもウィジェットを非表示にするページ除外設定(`tenants.excluded_page_patterns TEXT[]`)追加(`ADD COLUMN IF NOT EXISTS`、既定`'{}'`)。**★migration → デプロイの順。逆順は widget.js 配信が全テナントで500になる** — `src/api/widget/routes.ts` の `GET /widget/:tenantSlug.js` が `SELECT ... excluded_page_patterns FROM tenants` をフォールバック無しで発行しており、列が無いと42703が try/catch経由でそのまま500になる(該当テナントだけでなく全ウィジェット埋め込み先が影響を受ける)。同様に `GET /v1/admin/my-tenant`・`GET /v1/admin/tenants/:id`・CopilotUIツール(`get_tenant_settings`/`update_excluded_page_patterns`, `src/api/admin/agent/actionExecutor.ts`)も同じ列をフォールバック無しでSELECTしており、未適用のまま新コードを配備すると同時に500化する | ⬜ 未適用 |

### Phase A Day 2 migration 実行手順

> **本番適用済み (2026-08-16 実機確認)。** 以下は再構築時・別環境向けの記録。
> `ADD COLUMN IF NOT EXISTS` 主体のため再実行しても無害だが、通常は不要。

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

> **適用済み (2026-08-18 実機確認)。** 列 `flagged_for_improvement`(boolean, default false) と
> 部分インデックス `idx_feedback_flagged` の両方が本番に存在することを確認済み。
> 以下は再構築時・別環境向けの記録。

```bash
# DATABASE_URL の渡し方に注意。
# `ssh ... "psql \$DATABASE_URL ..."` は動かない — リモートの非対話シェルに
# DATABASE_URL は無く(/opt/rajiuce/.env にあるだけ)、psql が既定のUNIXソケット接続に
# フォールバックして `FATAL: role "root" does not exist` になる。接続情報が違うのではなく、
# 渡せていないだけなので、この失敗を「DBが壊れた」と誤診しないこと。
#
# .env を `source` / `. ./.env` しないこと。値にプレースホルダの山括弧が残っていると
# リダイレクトと解釈され、前後の行がコマンドとして実行されてシークレットが端末に出る
# (2026-08-08 に OpenAI キーが実際に露出した経路)。DATABASE_URL の行だけ取り出して渡す。
#
# 外側をシングルクォートにするとローカルシェルが中身に触れない。
# grep はローカル側で結果を絞るだけなので、接続文字列は画面にも履歴にも出ない。

# 1) 適用済みかの確認（何か出れば適用済み）
ssh root@65.108.159.161 'cd /opt/rajiuce && psql "$(grep -m1 ^DATABASE_URL= .env | cut -d= -f2-)" -c "\d feedback_messages"' | grep -E 'flagged_for_improvement|idx_feedback_flagged'

# 2) 未適用なら適用（ADD COLUMN IF NOT EXISTS なので二重実行しても無害）
ssh root@65.108.159.161 'cd /opt/rajiuce && psql "$(grep -m1 ^DATABASE_URL= .env | cut -d= -f2-)" -f /opt/rajiuce/src/api/admin/feedback/migration_feedback_flagged.sql'

# 3) 適用後は 1) を再実行して列とインデックスの両方を確認する。pm2 再起動は不要（列追加のみ）
```

**この列が無いと壊れるのは一覧だけではない。** `feedbackRepository.ts` の3関数すべてが参照しており、
とくに `sendMessage()` は `INSERT ... RETURNING flagged_for_improvement` なので**送信自体が失敗する**。
同ファイルに try/catch が0件のため、画面には一般文言しか出ず原因が分からない。
動作確認では一覧・送信・改善マークの**3つとも**見ること。

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

### 【人間作業】Stripe Dashboard — webhook 購読イベントに checkout.session.completed を追加

> UX-A(2026-08-26): client_admin セルフサービスの Checkout(mode: subscription)導線を追加した
> (`POST /v1/admin/my-tenant/billing/checkout-session`)。`stripeWebhook.ts` は
> `checkout.session.completed` を処理するハンドラを実装済みだが、**Stripe Dashboard の
> webhook エンドポイント設定で購読イベントに追加しないと、Stripe はこのイベントを
> 一切送ってこない**(コード側に受け口があっても発火しない)。

未追加のままだと: テナントがカード登録を完了しても `stripe_subscriptions` に行が
作られず、次にプランを変更したときの `syncSubscriptionItemsToPlan` が `no_subscription`
を返し続ける(=支払い設定が完了しているのに UI 上は「未完了」のまま)。

**手順**: Stripe Dashboard → Developers → Webhooks → 該当エンドポイント → 
「Select events」で `checkout.session.completed` を追加(既存の
`invoice.payment_succeeded` / `invoice.payment_failed` / `customer.subscription.deleted`
と並列で選ぶだけ。エンドポイントURL・署名シークレットは変更不要)。

**動作確認**: Stripe test mode で Checkout を1周させ、Dashboard の webhook ログで
`checkout.session.completed` が 200 を返していること、`stripe_subscriptions` に
該当テナントの行(`is_active=true`)が作られていることを確認する。

### stripe_webhook_events migration 実行手順

> **未適用。** Stripe webhook の冪等化に必要。**適用しないまま新コードをデプロイすると Stripe webhook が全件 500 になる。**

`createStripeWebhookHandler` は署名検証の直後に `stripe_webhook_events` へ処理権獲得の
条件付きUPSERTを発行する（`INSERT ... ON CONFLICT (event_id) DO UPDATE SET claimed_at = NOW()
WHERE completed_at IS NULL AND (claimed_at IS NULL OR claimed_at < ...)`）。
テーブル、または `completed_at` / `claimed_at` 列が無いと毎回例外になり、`handler_error` で 500 を返す。
Stripe は 5xx を一定期間リトライするが、migration を当てるまで**一度も成功しない**ため、
請求状態の更新 (`billing_status`)・支払い失敗の Slack 通知がすべて止まる。

**適用順序: デプロイ → migration。逆にはできない。**
`migration_stripe_webhook_events.sql` は rsync でVPSへ配布されるため、デプロイ前はVPS上にファイルが存在しない。

中間状態（デプロイ後・migration前）では webhook が 500 を返し続ける。Stripe のリトライ期間内に
migration を当てれば取りこぼしは自動で追いつくが、**リトライ期間を過ぎたイベントは失われる**
（その場合は Stripe ダッシュボードから手動で再送する）。
**できるだけ短く畳むため、デプロイ直後に続けて実行すること。**

```bash
# 1. デプロイ (唯一の手順)
bash SCRIPTS/deploy-vps.sh

# 2. バックアップ (必須)
ssh root@65.108.159.161 'cd /opt/rajiuce && pg_dump "$(grep -m1 ^DATABASE_URL= .env | cut -d= -f2-)" > /opt/backups/pre_stripe_webhook_events_$(date +%Y%m%d_%H%M).sql'

# 3. 適用前の確認 — テーブルと completed_at 列の有無
#    (テーブルだけ存在して completed_at が無い状態がありうる。両方見ること)
ssh root@65.108.159.161 'cd /opt/rajiuce && psql "$(grep -m1 ^DATABASE_URL= .env | cut -d= -f2-)" -c "\d stripe_webhook_events"'

# 4. Migration 実行 (CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS なので二重実行しても無害)
ssh root@65.108.159.161 'cd /opt/rajiuce && psql "$(grep -m1 ^DATABASE_URL= .env | cut -d= -f2-)" -f /opt/rajiuce/src/lib/billing/migration_stripe_webhook_events.sql'

# 5. 確認 — event_id(PK) / event_type(NOT NULL) / created_at / completed_at / claimed_at の5列が揃っていること
#    (claimed_at が無いと並行配信時の二重実行防止が効かず、UPSERTが例外になる)
ssh root@65.108.159.161 'cd /opt/rajiuce && psql "$(grep -m1 ^DATABASE_URL= .env | cut -d= -f2-)" -c "\d stripe_webhook_events"'
```

**動作確認**: Stripe ダッシュボードの webhook ログで、直近のイベントが 200 を返していること。
同一イベントを手動再送すると 2回目は `{"received":true,"duplicate":true}` になる。

**ロールバック**: 新規テーブルのみで既存テーブルへの変更が無いため、コードを戻せばテーブルは無害な残骸になる。

### phase75 judge 一意制約 migration 実行手順

> **未適用。** judge 評価の多重登録を止めるために必要。
> **★これまでの migration と適用順序が逆。「migration → デプロイ」で当てること。**

`judgeEvaluator.ts` / `evaluationAnalyzer.ts` の INSERT は
`ON CONFLICT (tenant_id, session_id)` / `ON CONFLICT (tenant_id, trigger_pattern)` と
**ターゲットを明示**するようになった。対応する一意インデックスが無い状態でこのコードが動くと
Postgres が `there is no unique or exclusion constraint matching the ON CONFLICT specification`
を返し、**評価の保存と提案ルールの保存が全件失敗する**（チャット自体は止まらないが、
Judge 評価機能が無言で死ぬ。管理画面の手動トリガーは 500）。

**先に migration を当てられる。** この2本は既存テーブルにしか触れず、新コードに依存しないため、
rsync を待たずローカルから stdin で流し込める。中間状態を作らずに済むので、この順で当てること。

```bash
# 1. バックアップ (必須。重複削除は元に戻せない)
ssh root@65.108.159.161 'cd /opt/rajiuce && pg_dump "$(grep -m1 ^DATABASE_URL= .env | cut -d= -f2-)" > /opt/backups/pre_phase75_judge_unique_$(date +%Y%m%d_%H%M).sql'

# 2. 適用前の確認 — 重複がどれだけあるか / 消える行に人の判断が乗っていないか
#    ★各SQLファイル冒頭の「1. 事前確認」のクエリを実行し、結果を目視してから 3 へ進む。
#      特に「削除対象に承認済みルールが含まれていないか」は 0 件であることを確認する。
#      0 件でない場合は、そのまま流さず残す行の優先順位を見直すこと。
ssh root@65.108.159.161 'cd /opt/rajiuce && psql "$(grep -m1 ^DATABASE_URL= .env | cut -d= -f2-)" -c "
  SELECT tenant_id, session_id, COUNT(*) AS dup FROM conversation_evaluations
  GROUP BY tenant_id, session_id HAVING COUNT(*) > 1 ORDER BY dup DESC LIMIT 20;"'

# 3. Migration 実行 (デプロイ前。ローカルのファイルを stdin で流す)
ssh root@65.108.159.161 'cd /opt/rajiuce && psql "$(grep -m1 ^DATABASE_URL= .env | cut -d= -f2-)"' \
  < src/migrations/phase75_conversation_evaluations_unique.sql
ssh root@65.108.159.161 'cd /opt/rajiuce && psql "$(grep -m1 ^DATABASE_URL= .env | cut -d= -f2-)"' \
  < src/migrations/phase75_tuning_rules_unique.sql

# 4. 確認 — 一意インデックスが2本とも表示されること
#    (SQL内にシングルクォートを持ち込まないよう \d で確認する)
ssh root@65.108.159.161 'cd /opt/rajiuce && psql "$(grep -m1 ^DATABASE_URL= .env | cut -d= -f2-)" -c "\d conversation_evaluations" -c "\d tuning_rules" | grep -E "uniq_conv_eval_session|uniq_tuning_rules_tenant_trigger"'

# 5. デプロイ
bash SCRIPTS/deploy-vps.sh
```

**動作確認**: デプロイ後、`JUDGE_AUTO_EVALUATE=true` の状態で会話を1本終端まで進め、
`conversation_evaluations` に**1行だけ**入ること。

> ⚠️ **PR-10 訂正 (2026-08-23)**: 上記手順が前提とする「ターン予算(既定12)」
> 「終端まで進める」は Phase22 の flow 状態機械(clarify→answer→confirm→terminal)
> の概念だが、その一式は本番未配線のまま PR-10 で削除済み（学習ループ監査R10/D5）。
> `JUDGE_AUTO_EVALUATE` という環境変数もコード上に存在しない。本節は実行不可能な
> 検証手順だったため、実施しないこと。`conversation_evaluations` への重複挿入
> 防止自体は `uniq_conv_eval_session` インデックス側で担保されている。

```bash
ssh root@65.108.159.161 'cd /opt/rajiuce && psql "$(grep -m1 ^DATABASE_URL= .env | cut -d= -f2-)" -c "
  SELECT session_id, COUNT(*) FROM conversation_evaluations
  GROUP BY session_id ORDER BY COUNT(*) DESC LIMIT 5;"'
```

**ロールバック**: `DROP INDEX uniq_conv_eval_session;` / `DROP INDEX uniq_tuning_rules_tenant_trigger;`
でインデックスは戻せるが、**重複削除した行は戻らない**（手順1のバックアップから復旧すること）。
なお、インデックスを落とすなら **コードも同時に戻す**こと（ターゲット付き ON CONFLICT が
残ったままインデックスだけ消すと INSERT が全件失敗する）。

### 本番500の解消 migration 実行手順 (2026-08-16 実測、Asana 1217530758061266)

> **本番適用済み・全て解消確認済み (2026-08-16)。** 以下は発生時の記録・再構築時の手順として残す。
> 適用後、この5本に加えて `phase72a_tenant_settings_history.sql` / `phase72d_metrics_snapshots.sql`
> (設定変更履歴500の追加対応) も適用し、テナント詳細17タブ全てで500が解消したことを実機確認済み。

> 適用当時の状況: 本番の実機検証で以下4系統の500が確認されており、いずれも
> 列/テーブルの未適用が原因だった。**コードのデプロイでは解消しない。**

```
GET /v1/admin/my-tenant                     500 {"error":"取得に失敗しました"}
GET /v1/admin/tenants/:id                   500 (全テナントで再現)
GET /v1/admin/feedback?unread=true&limit=5  500 {"error":"フィードバック一覧の取得に失敗しました"}
GET /v1/admin/analytics/flow-transitions    500 {"error":"フロー遷移の集計に失敗しました"}
```

**原因の切り分け根拠**: 一覧の `GET /v1/admin/tenants` は200で通り、500になる2本
(`my-tenant` / `tenants/:id`)だけが列を追加で SELECT している。差分列がそのまま原因。
共通処理の `fetchOnboardingStageStatus` は全クエリが try/catch 済みで500を出せない構造。

| 適用するファイル | 追加されるもの | どの500が直るか |
|---|---|---|
| `src/api/admin/tenants/migration_faq_hints.sql` | `tenants.faq_question_hint` / `faq_answer_hint` | my-tenant / tenants/:id |
| `src/api/admin/tenants/migration_onboarding.sql` | `tenants.onboarding_industry` / `onboarding_completed_at` / `onboarding_widget_seen_at` | 同上 |
| `src/api/admin/agent/migration_admin_agent_columns.sql` | `tenants.ga4_measurement_id` / `posthog_host` / `widget_theme` | 同上 |
| `src/api/admin/feedback/migration_admin_feedback_reply.sql` | `admin_feedback` の返信5列 + 部分インデックス | feedback?unread=true |
| `src/migrations/phase72c_conversation_flow_logs.sql` | `conversation_flow_logs` テーブル + 3インデックス | flow-transitions |

**安全性(適用前に確認済み)**

- 全て `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`。
  **再実行しても無害**。既にどれかが適用済みでも順序を気にせず流せる。
- `DROP`・既存列の型変更・既存行の UPDATE は**一つも含まれない**。
- PostgreSQL 11+ では `ADD COLUMN ... DEFAULT` はテーブル書き換えを伴わないため、
  行数に関わらずロックは一瞬(本番は PG16)。
- FK は `admin_feedback.parent_feedback_id UUID → admin_feedback(id)` の自己参照1本のみ。
  `admin_feedback.id` は `UUID PRIMARY KEY` で型は一致している。

**リハーサル済み (2026-08-16)**

本番と同じ前提スキーマ(`tenants` / `admin_feedback` / `knowledge_gaps`)を作った
PostgreSQL 17 の使い捨てDBに対して、5本を実際に流して以下を確認済み:

- 5本とも `ON_ERROR_STOP=1` 付きで**エラーなく完走**
- **2回流しても EXIT 0**(2回目は全て `already exists, skipping` の NOTICE のみ)
- 500になっている**4本の実クエリ**(`my-tenant` / `tenants/:id` の実SELECT、
  feedback の未読WHERE句、flow-transitions の集計)が**いずれも正常に実行できる**

**既知の副作用(実害なし、ただし見た目が変わる)**

`posthog_host` は `DEFAULT 'https://app.posthog.com'` を持つため、適用後は全テナントで
この値が入る(リハーサルで実際に全行へ入ることを確認済み。`widget_theme` は `{}`)。
チャットの `get_tenant_settings` の表示が「PostHog ホスト: 未設定」からこのURLに変わる。
**PostHog の有効化は別列 `posthog_project_api_key_encrypted` が握っており、
データ送信が始まることはない。**

**デプロイとの順序**: どちらが先でもよい。コードは既に本番へ出ており(PR #748〜#759)、
現在は「列が無いので500」の状態。migration 単独で解消する。

適用対象の `.sql` は既に VPS 上にある(いずれも以前からの tracked file で、
本日のデプロイで `/opt/rajiuce/` へ配布済み)。**このためデプロイ待ちは不要。**
確認クエリだけは新規なので、ファイル参照ではなく標準入力で流す。

```bash
# 1. 適用前の確認 — MISSING が出た項目が原因。結果はAsanaに記録する
#    heredoc はローカル側で組み立て、sshの標準入力経由でpsqlに渡す
#    (ssh "..." の引用符の中にheredocを入れる形は壊れやすいので使わない)
ssh root@65.108.159.161 'psql $DATABASE_URL -t -A -F" "' <<'SQL'
SELECT 'tenants.'||c.name,
       CASE WHEN col.column_name IS NULL THEN 'MISSING' ELSE 'ok' END
FROM (VALUES ('faq_question_hint'),('faq_answer_hint'),('onboarding_industry'),
             ('onboarding_completed_at'),('onboarding_widget_seen_at'),
             ('widget_theme'),('ga4_measurement_id'),('posthog_host')) AS c(name)
LEFT JOIN information_schema.columns col
  ON col.table_name='tenants' AND col.column_name=c.name;
SELECT 'admin_feedback.'||c.name,
       CASE WHEN col.column_name IS NULL THEN 'MISSING' ELSE 'ok' END
FROM (VALUES ('reply_body'),('replied_at'),('replied_by_email'),
             ('reply_read_at'),('parent_feedback_id')) AS c(name)
LEFT JOIN information_schema.columns col
  ON col.table_name='admin_feedback' AND col.column_name=c.name;
SELECT 'table.conversation_flow_logs',
       CASE WHEN to_regclass('conversation_flow_logs') IS NULL THEN 'MISSING' ELSE 'ok' END;
SQL
```

```bash
# 2. バックアップ (必須)
ssh root@65.108.159.161 "pg_dump \$DATABASE_URL > /opt/backups/pre_500fix_\$(date +%Y%m%d_%H%M).sql"
```

```bash
# 3. 適用 (順序は任意。全て冪等)
ssh root@65.108.159.161 "psql \$DATABASE_URL -v ON_ERROR_STOP=1 \
  -f /opt/rajiuce/src/api/admin/tenants/migration_faq_hints.sql \
  -f /opt/rajiuce/src/api/admin/tenants/migration_onboarding.sql \
  -f /opt/rajiuce/src/api/admin/agent/migration_admin_agent_columns.sql \
  -f /opt/rajiuce/src/api/admin/feedback/migration_admin_feedback_reply.sql \
  -f /opt/rajiuce/src/migrations/phase72c_conversation_flow_logs.sql"
```

`ON_ERROR_STOP=1` を付けているため、途中で失敗すればそこで止まる(残りは流れない)。
**API の再起動は不要** — 列の追加はアプリ側のキャッシュに影響しない。

**4. 適用後の確認**: 手順1と同じクエリを再実行し、`MISSING` が0件になること。

**動作確認 (4系統すべて 200 になること)**

```bash
# client_admin のトークンで
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" https://api.r2c.biz/v1/admin/my-tenant
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" "https://api.r2c.biz/v1/admin/feedback?unread=true&limit=5"
# super_admin のトークンで
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $SA_TOKEN" https://api.r2c.biz/v1/admin/tenants/carnation
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $SA_TOKEN" "https://api.r2c.biz/v1/admin/analytics/flow-transitions?period=30d"
```

画面側は以下も確認する。**テナント詳細の15タブは今回の一連の作業で唯一まだ一度も
検証できていない範囲**なので、ここで初めて確認できる。

- `/admin/tenants/:id` が開き、15タブが描画される
- client_admin のサイドバーにプランに応じて「会話分析」「成約・効果分析」が戻る
  (`my-tenant` の500で `tenantPlan` が null になり、全テナントから消えていた)
- チャットで `get_tenant_settings` / `get_embed_code` が「取得に失敗しました」を返さない

**ロールバック**: 列の追加のみでデータ変更が無いため、通常は不要(コードを戻しても
未使用の列が残るだけ)。列を消す場合は既存データの消失を伴うので、バックアップからの
リストアを選ぶこと。`conversation_flow_logs` は新規テーブルのため
`DROP TABLE IF EXISTS conversation_flow_logs;` で戻せる。

## PM2 instances を増やす前に (現在は instances:1 / fork モードのため未対応)

`ecosystem.config.cjs` の `rajiuce-api` は現在 `instances: 1` / `exec_mode: "fork"`。
将来スケールアウトのために `instances` を1より大きくする、または `exec_mode: "cluster"` に
変更する場合、以下4つのプロセスローカルなインメモリ状態が**プロセスごとに別々の値を持ち、
同時に不整合を起こす**。1つでも対応漏れがあると、リクエストがどのワーカーに振られるかで
挙動が変わる不具合になる。

| 状態 | 場所 | 増やすと何が起きるか | 対応の方向性 |
|---|---|---|---|
| 会話履歴3ストア | `src/agent/dialog/{contextStore,salesContextStore,flowContextStore}.ts` | 同一セッションの続きが別ワーカーに振られると会話履歴が消えたように見える | Redis 等の外部ストアへ移行、または L4(ロードバランサ)でセッションIDによる sticky routing |
| rate-limit バケット | `src/lib/rate-limit.ts` | 上限がワーカー数倍に緩む(各ワーカーが独立してカウントするため) | Redis 等の外部カウンタへ移行 |
| テナントレジストリ | `src/lib/tenant-context.ts` (`tenantStore`, `additionalApiKeys`) | キー発行・失効・allowed_origins更新の即時反映(#809/#814/#824/#836)が反映されたワーカーとされていないワーカーで割れる | PM2 の `pm2 reload` はゼロダウンタイムでワーカーを順次再起動するため、DB更新をトリガーに全ワーカーへブロードキャストする仕組み(pub/sub 等)が必要 |

**現状の結論**: `instances:1` のままである限り対応不要。上記表は「増やすと決めた時」の
着手前チェックリストとして残す。

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
