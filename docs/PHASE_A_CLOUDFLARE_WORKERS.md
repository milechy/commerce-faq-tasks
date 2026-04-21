# Phase A Cloudflare Workers 設計書

**作成日**: 2026-04-21  
**対象フェーズ**: Phase A Day 1 (初期セットアップ) → Day 4 (実機能実装)  
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
                          │  │  [Cron Trigger]             │ │
                          │  │  */10 * * * *               │ │
                          │  │  → GA4 データ同期           │ │
                          │  │  → CV重複排除               │ │
                          │  │  → Email送信                │ │
                          │  └───────────┬─────────────────┘ │
                          │              │ HMAC認証           │
                          └──────────────┼───────────────────┘
                                         │
                                         ▼ HTTPS
                          ┌──────────────────────────────────┐
                          │  Hetzner VPS (65.108.159.161)    │
                          │                                   │
                          │  Nginx (api.r2c.biz)              │
                          │    ↓                              │
                          │  PM2 rajiuce-api (port 3100)     │
                          │    /internal/analytics/sync       │
                          │    /internal/cv/deduplicate       │
                          │    /internal/report/weekly        │
                          │                                   │
                          │  PostgreSQL (pgvector)            │
                          │  Elasticsearch                    │
                          └──────────────────────────────────┘
```

---

## Workers → VPS 内部API通信フロー

### Cron 実行フロー

```
1. Cloudflare Cron Trigger (*/10 * * * *)
   └─▶ scheduled() ハンドラ起動

2. Worker がタスクを判定
   ├─ GA4 sync (毎時 :00)
   ├─ CV dedup (10分ごと)
   └─ Weekly report (月曜 09:00 JST)

3. VPS 内部API エンドポイントへ HTTPS POST
   URL: ${INTERNAL_API_URL}/internal/analytics/sync
   Headers:
     X-Internal-Request: 1
     X-HMAC-Timestamp: <unix_timestamp>
     X-HMAC-Signature: <HMAC-SHA256>
   Body: { "task": "ga4_sync", "tenant_id": "..." }

4. VPS API がリクエストを受理
   └─ HMAC検証 → タスク実行 → 202 Accepted

5. Worker がレスポンスをログに記録
```

### HMAC 認証設計

Workers と VPS 間の内部通信を HMAC-SHA256 で保護する。

```typescript
// Worker 側: 署名生成
const timestamp = Math.floor(Date.now() / 1000).toString();
const message = `${timestamp}:${JSON.stringify(body)}`;
const key = await crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(env.INTERNAL_API_HMAC_SECRET),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign']
);
const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
const signatureHex = Array.from(new Uint8Array(signature))
  .map(b => b.toString(16).padStart(2, '0'))
  .join('');

// リクエストヘッダーに付与
headers['X-Internal-Request'] = '1';
headers['X-HMAC-Timestamp'] = timestamp;
headers['X-HMAC-Signature'] = signatureHex;
```

```typescript
// VPS 側: 署名検証 (既存 X-Internal-Request ミドルウェアに追加)
function verifyHmac(req: Request): boolean {
  const timestamp = req.headers['x-hmac-timestamp'];
  const signature = req.headers['x-hmac-signature'];

  // タイムスタンプの鮮度確認 (5分以内)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const message = `${timestamp}:${JSON.stringify(req.body)}`;
  const expected = createHmac('sha256', process.env.INTERNAL_API_HMAC_SECRET!)
    .update(message)
    .digest('hex');
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

### リプレイ攻撃対策

- タイムスタンプが現在時刻 ± 5分以内でなければ拒否
- `X-Internal-Request: 1` は既存ミドルウェアで確認済み (二重チェック)

---

## 環境変数一覧

### Worker 側 (wrangler.jsonc で定義)

| 変数名 | 種別 | 説明 |
|---|---|---|
| `INTERNAL_API_URL` | var | VPS API のベース URL (例: `https://api.r2c.biz`) |
| `INTERNAL_API_HMAC_SECRET` | secret | HMAC署名用シークレット (wrangler secret コマンドで設定) |
| `ENVIRONMENT` | var | `development` / `production` |

### VPS 側 (.env に追加)

| 変数名 | 説明 |
|---|---|
| `INTERNAL_API_HMAC_SECRET` | Worker と同じシークレット (共有鍵) |
| `CLOUDFLARE_WORKER_ALLOWED_IPS` | Workers からの固定IPリスト (オプション) |

### Wrangler Secret 設定手順

```bash
# ローカル開発時
echo "your-secret-here" | npx wrangler secret put INTERNAL_API_HMAC_SECRET

# または .dev.vars ファイル (gitignore 必須)
echo "INTERNAL_API_HMAC_SECRET=your-secret-here" > .dev.vars
```

---

## デプロイ手順

### 手動デプロイ

```bash
cd cloudflare-workers/r2c-analytics-worker

# 依存関係インストール
npm install

# TypeScript ビルド確認
npm run build

# ローカル開発サーバー起動
npx wrangler dev

# 本番デプロイ
npx wrangler deploy --env production
```

### GitHub Actions 自動デプロイ (将来実装)

```yaml
# .github/workflows/deploy-workers.yml (Day 4 以降に追加)
name: Deploy Cloudflare Workers
on:
  push:
    branches: [main]
    paths:
      - 'cloudflare-workers/**'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          workingDirectory: cloudflare-workers/r2c-analytics-worker
          command: deploy --env production
```

### 必要な Cloudflare アカウント設定

1. **Paid Plan** — Workers Cron Triggers は有料プランのみ
2. **API Token** — `Edit Cloudflare Workers` 権限
3. **Email Routing** — `send_email` binding のために Email Routing を有効化
4. **Custom Domain** (オプション) — Worker に独自ドメインを割り当てる場合

---

## Day 1 → Day 4 実装ロードマップ

### Day 1 (現在): 初期セットアップ
- `wrangler.jsonc`, `package.json`, `src/index.ts`, `tsconfig.json` を作成
- Hello World + Cron ハンドラの骨組みのみ

### Day 4: 実機能実装
- **Cron 1** (`*/10 * * * *`): CV 重複排除バッチ → VPS `/internal/cv/deduplicate` を叩く
- **Cron 2** (`0 * * * *`): GA4 データ同期 → VPS `/internal/analytics/ga4-sync` を叩く
- **Cron 3** (`0 0 * * 1`): 週次レポート生成 → VPS `/internal/report/weekly` → Email 送信
- **Email Service binding**: 成功/失敗通知メールを Cloudflare Email Routing 経由で送信

### VPS 側で必要な内部 API エンドポイント (Day 2 以降)

```
POST /internal/analytics/sync
POST /internal/cv/deduplicate
POST /internal/report/weekly
```

これらは既存の `X-Internal-Request: 1` ミドルウェアで保護し、HMAC 検証を追加する。

---

## ディレクトリ構造

```
cloudflare-workers/
└── r2c-analytics-worker/
    ├── wrangler.jsonc        ← Cloudflare Workers 設定
    ├── package.json          ← 依存関係
    ├── tsconfig.json         ← TypeScript 設定
    ├── .dev.vars             ← ローカル開発用シークレット (gitignore済み)
    └── src/
        └── index.ts          ← Worker エントリポイント
```

---

## 注意事項

- `.dev.vars` は `.gitignore` に追加済みであること（シークレットの漏洩防止）
- Workers の無料プランには Cron Triggers がないため、Paid Plan ($5/月) が必要
- HMAC シークレットは VPS の `.env` と Worker の Secrets に同じ値を設定すること
- `wrangler deploy` 前に必ず `npx wrangler dev` でローカル動作確認を行うこと

---

*設計書作成: Claude Code (Sonnet 4.6) — 2026-04-21*
