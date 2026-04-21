# Phase A Cloudflare Workers 設計・実装書

**作成日**: 2026-04-21  
**更新日**: 2026-04-21 (Day 4 実装完了)  
**担当**: Claude Code (Sonnet 4.6)

---

## アーキテクチャ概要

```
                          ┌──────────────────────────────────┐
                          │        Cloudflare Platform        │
                          │                                   │
  パートナー              │  ┌─────────────────────────────┐ │
  ブラウザ ──────────────▶│  │  Cloudflare Pages           │ │
                          │  │  (admin.r2c.biz)            │ │
                          │  └───────────────┬─────────────┘ │
                          │                  │                │
                          │  ┌───────────────▼─────────────┐ │
                          │  │  r2c-analytics-worker       │ │
                          │  │  (Cloudflare Workers)       │ │
                          │  │                             │ │
                          │  │  [Cron: */10 * * * *]       │ │
                          │  │  → GA4ヘルスチェック        │ │
                          │  │  → エラー時メール通知       │ │
                          │  │                             │ │
                          │  │  [HTTP: POST /send-notif.]  │ │
                          │  │  → VPS起点のメール送信      │ │
                          │  └───────────┬─────────────────┘ │
                          │              │ HMAC認証           │
                          └──────────────┼───────────────────┘
                                         │
                                         ▼ HTTPS
                          ┌──────────────────────────────────┐
                          │  Hetzner VPS (api.r2c.biz)       │
                          │                                   │
                          │  POST /internal/ga4/health-check-all  │
                          │  POST /internal/ga4/health-check  │
                          │  POST /internal/ga4/sync          │
                          │                                   │
                          │  PostgreSQL (pgvector)            │
                          └──────────────────────────────────┘
```

---

## ディレクトリ構造

```
cloudflare-workers/
└── r2c-analytics-worker/
    ├── wrangler.jsonc                   ← Workers 設定 (Cron / Email binding)
    ├── package.json                     ← 依存関係 (wrangler, workers-types)
    ├── tsconfig.json                    ← TypeScript 設定
    ├── .dev.vars                        ← ローカル開発用シークレット (gitignore済み)
    └── src/
        ├── index.ts                     ← エントリポイント (scheduled + fetch handlers)
        ├── types.ts                     ← Env interface + 共有型定義
        ├── globals.d.ts                 ← EmailMessage コンストラクタ型拡張
        ├── lib/
        │   ├── hmacSigner.ts           ← HMAC-SHA256 署名生成 (VPS hmacVerifier対応)
        │   ├── vpsApiClient.ts         ← VPS 内部 API 呼び出し
        │   └── emailSender.ts          ← Cloudflare Email Service binding wrapper
        └── handlers/
            ├── ga4HealthCheckHandler.ts ← Cronハンドラ: 全テナント一括チェック + メール通知
            └── errorNotifyHandler.ts   ← POST /send-notification ハンドラ
```

---

## Cron 動作フロー

```
1. Cloudflare Cron Trigger (*/10 * * * *)
   └─▶ scheduled() → runGa4HealthCheckCron(env)

2. VPS POST /internal/ga4/health-check-all (HMAC署名付き)
   └─▶ 全連携テナントのGA4接続チェック結果を一括取得

3. エラーステータス (error / timeout / permission_revoked) のテナントを検出
   └─▶ 同一テナントへの通知を1時間以内に重複送信しない (in-memoryデデュプ)

4. エラー検知時: Cloudflare Email Service でアラートメール送信
   件名: [R2C] GA4連携エラー検知 (tenant: xxx)
   宛先: ALERT_EMAIL_TO 環境変数
```

---

## HTTP エンドポイント

| Path | Method | 説明 |
|---|---|---|
| `/health` | GET | Workers ヘルスチェック (公開) |
| `/send-notification` | POST | VPS 起点のメール送信 (HMAC認証必須) |

---

## HMAC 認証設計

Workers と VPS は共通シークレット `INTERNAL_API_HMAC_SECRET` で通信を保護する。

```
メッセージ形式: "{timestamp}:{JSON.stringify(body)}"
アルゴリズム: HMAC-SHA256 (hex)
タイムスタンプ許容誤差: ±5分
```

Workers 側 (`src/lib/hmacSigner.ts`) と VPS 側 (`src/lib/crypto/hmacVerifier.ts`) で
同じメッセージ形式を使用。

---

## 環境変数一覧

### Worker 側

| 変数名 | 種別 | 説明 |
|---|---|---|
| `INTERNAL_API_URL` | var | VPS API ベース URL (`https://api.r2c.biz`) |
| `ALERT_EMAIL_TO` | var | エラー通知メール送信先 |
| `ENVIRONMENT` | var | `development` / `production` |
| `INTERNAL_API_HMAC_SECRET` | **secret** | HMAC 署名用シークレット |

### VPS 側 (.env に追加)

| 変数名 | 説明 |
|---|---|
| `INTERNAL_API_HMAC_SECRET` | Workers と同じシークレット (共有鍵) |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | GA4 サービスアカウント JSON (base64) |

---

## デプロイ手順

### 1. シークレット設定

```bash
cd cloudflare-workers/r2c-analytics-worker

# Wrangler でシークレット登録 (VPS .env の INTERNAL_API_HMAC_SECRET と同じ値)
echo "your-secret-here" | npx wrangler secret put INTERNAL_API_HMAC_SECRET
```

### 2. ローカル動作確認

```bash
# .dev.vars ファイルを作成 (gitignore済み)
echo "INTERNAL_API_HMAC_SECRET=your-secret-here" > .dev.vars

# ローカル開発サーバー起動
npm run dev

# 別ターミナルで Cron Trigger を手動発火
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"

# ヘルスチェック確認
curl http://localhost:8787/health
```

### 3. ステージングデプロイ

```bash
npm run build   # dry-run でビルド確認
npm run deploy  # wrangler deploy (development環境)
```

### 4. 本番デプロイ

```bash
npm run deploy:prod  # wrangler deploy --env production
```

### 5. デプロイ後確認

- Cloudflare Workers 管理画面でCron Trigger 実行履歴を確認
- Email Routing 管理画面で Email binding が有効であることを確認
- `https://r2c-analytics-worker.{your-subdomain}.workers.dev/health` でヘルスチェック

---

## トラブルシューティング

### Email 送信失敗

**原因**: Email Routing が有効になっていない / `destination_address` 制限
```
解決: Cloudflare Dashboard → Email Routing → Enable
     wrangler.jsonc の destination_address を確認
     本番では send_email binding の destination_address を削除 (全宛先に送信可能にする)
```

### HMAC mismatch (401 エラー)

**原因**: Worker のシークレットと VPS の INTERNAL_API_HMAC_SECRET が一致しない
```
解決: wrangler secret put INTERNAL_API_HMAC_SECRET で再設定
     VPS .env を確認: INTERNAL_API_HMAC_SECRET=同じ値
```

### VPS タイムアウト (25秒)

**原因**: テナント数が多い場合、全テナント一括チェックが25秒を超える
```
解決 (将来): health-check-all を並列度制限付き実装 (pLimit等)
```

### Cron が実行されない

**原因**: Workers Paid Plan ($5/月) が未契約
```
解決: Cloudflare Dashboard → Workers & Pages → Upgrade to Paid Plan
```

---

## 次ステップ (Day 5)

- PostHog 統合 (widget.js + backend イベント送信)
- LLM Analytics 接続
- Event ID 重複排除実装 (conversion_attributions テーブル)
- Cloudflare Workers KV による永続的デデュプリケーション (現在はin-memory)

---

*設計書作成: Claude Code (Sonnet 4.6) — 2026-04-21*  
*Day 4 実装更新: Claude Code (Sonnet 4.6) — 2026-04-21*
