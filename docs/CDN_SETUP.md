# CDN セットアップ手順書

> Phase33 Stream D — Widget CDN配信 & グローバル展開インフラ
> 最終更新: 2026-03-12

---

## 概要

RAJIUCE FAQ Widget (`public/widget.js`) をCloudflare CDNで配信するための設定手順書です。
**実際のCloudflare設定変更はインフラ担当者が行ってください。** このドキュメントは手順書です。

---

## Widget 配信 URL 設計

| 環境 | URL | 説明 |
|------|-----|------|
| 開発 | `http://65.108.159.161:3100/widget.js` | VPS直接アクセス |
| ステージング | `https://cdn-staging.rajiuce.com/widget.latest.min.js` | Cloudflare経由 |
| 本番（バージョン固定） | `https://cdn.rajiuce.com/widget.v1.0.0.min.js` | キャッシュ最大化 |
| 本番（最新版） | `https://cdn.rajiuce.com/widget.latest.min.js` | 自動更新 |

### クライアントへの埋め込み例

```html
<!-- 本番: バージョン固定（推奨 — キャッシュ効率最大） -->
<script
  src="https://cdn.rajiuce.com/widget.v1.0.0.min.js"
  data-tenant="YOUR_TENANT_ID"
  data-api-key="YOUR_API_KEY"
  async
></script>

<!-- 本番: 常に最新版 -->
<script
  src="https://cdn.rajiuce.com/widget.latest.min.js"
  data-tenant="YOUR_TENANT_ID"
  data-api-key="YOUR_API_KEY"
  async
></script>
```

---

## Widget ビルド手順

事前に `SCRIPTS/build-widget.sh` でMinify版を生成します。

```bash
# 依存ツールのインストール（初回のみ）
pnpm add -D terser

# ビルド（バージョン番号を指定）
bash SCRIPTS/build-widget.sh 1.0.0

# 出力先: dist/widget/
# - widget.js                  (開発用)
# - widget.v1.0.0.js           (バージョン付き)
# - widget.v1.0.0.min.js       (Minify版)
# - widget.v1.0.0.min.js.gz    (gzip事前圧縮版)
# - widget.latest.min.js       (最新版シンボリックリンク)
```

ビルド後、`dist/widget/` をVPS の `/var/www/cdn/` に配置します。

```bash
# VPSへのアップロード例
rsync -avz dist/widget/ user@65.108.159.161:/var/www/cdn/widget/
```

---

## Cloudflare セットアップ手順

### 1. DNS 設定

Cloudflareダッシュボード → DNS → Records

```
Type: CNAME
Name: cdn
Target: 65.108.159.161  (または VPS のホスト名)
Proxy: ON (オレンジ雲 ✓)
TTL: Auto
```

### 2. SSL/TLS 設定

Cloudflare → SSL/TLS → Overview

```
暗号化モード: Full (strict)
```

Cloudflare → SSL/TLS → Edge Certificates

```
Always Use HTTPS: ON
Minimum TLS Version: TLS 1.2
Automatic HTTPS Rewrites: ON
```

### 3. Cache Rules（キャッシュルール）

Cloudflare → Caching → Cache Rules → Create rule

#### ルール 1: Widget バージョン付きファイル（長期キャッシュ）

```
Rule name: Widget Versioned Files
If: URI Path matches regex
  ^/widget\.v[\d.]+\.min\.js(\.gz)?$
Then:
  Cache Status: Cache Everything
  Edge Cache TTL: 1 year
  Browser Cache TTL: 1 year
  Cache Key: Default
```

#### ルール 2: Widget 最新版（短期キャッシュ）

```
Rule name: Widget Latest
If: URI Path matches regex
  ^/widget\.(latest|js)(\.min\.js)?(\.gz)?$
Then:
  Cache Status: Cache Everything
  Edge Cache TTL: 1 hour
  Browser Cache TTL: 1 hour
  Cache Key: Default
```

#### ルール 3: API エンドポイント（キャッシュ禁止）

```
Rule name: API No Cache
If: URI Path starts with
  /api/ OR /dialog/ OR /agent OR /search OR /v1/ OR /health OR /metrics
Then:
  Cache Status: Bypass
  Browser Cache TTL: No override
```

### 4. セキュリティヘッダー（Transform Rules）

Cloudflare → Rules → Transform Rules → Modify Response Header

#### CDN配信用セキュリティヘッダーを追加

```
Rule name: Security Headers - Widget CDN
If: Hostname equals cdn.rajiuce.com
Then (Set header):
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  X-XSS-Protection: 1; mode=block
  Referrer-Policy: strict-origin-when-cross-origin
  Cross-Origin-Resource-Policy: cross-origin
  Access-Control-Allow-Origin: *
  Access-Control-Allow-Methods: GET, HEAD, OPTIONS
  Access-Control-Max-Age: 86400
```

> **注意**: `Access-Control-Allow-Origin: *` は widget.js（静的ファイル）のみに適用。
> API エンドポイント（api.rajiuce.com）には適用しないこと。

#### gzip 事前圧縮ファイルの Content-Encoding 設定

`.gz` ファイルを直接配信する場合、Nginx 側で設定が必要（後述）。
Cloudflare は Brotli/gzip を自動で適用するため、`.gz` 拡張子ファイルの直接配信は通常不要。

### 5. レート制限（Cloudflare WAF）

Cloudflare → Security → WAF → Rate limiting rules

#### Widget 配信へのレート制限

```
Rule name: Widget CDN Rate Limit
Expression: (http.host eq "cdn.rajiuce.com")
Rate: 1000 requests per 1 minute per IP
Action: Block (HTTP 429)
```

#### ボット防御

Cloudflare → Security → Bots → Bot Fight Mode: ON

### 6. Page Rules（追加設定）

> **注意**: Cache Rules が優先されるため、Page Rules は補完的に使用

```
URL: cdn.rajiuce.com/widget.v*.min.js
Settings:
  Cache Level: Cache Everything
  Edge Cache TTL: a year
  Browser Cache TTL: a year
```

---

## Nginx 設定（VPS側）

VPS の Nginx で widget ファイルを配信する設定。

```nginx
# /etc/nginx/sites-available/cdn.rajiuce.com

server {
    listen 80;
    listen [::]:80;
    server_name cdn.rajiuce.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name cdn.rajiuce.com;

    # SSL（Cloudflare Origin Certificate を推奨）
    ssl_certificate /etc/ssl/cloudflare/cdn.rajiuce.com.pem;
    ssl_certificate_key /etc/ssl/cloudflare/cdn.rajiuce.com.key;

    root /var/www/cdn/widget;
    index index.html;

    # gzip
    gzip on;
    gzip_vary on;
    gzip_types text/javascript application/javascript;
    gzip_min_length 1000;

    # バージョン付きファイル: 1年キャッシュ (immutable)
    location ~* ^/widget\.v[\d.]+\.min\.js(\.gz)?$ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        add_header X-Content-Type-Options nosniff;
        add_header Access-Control-Allow-Origin *;
        expires 1y;

        # gzip 事前圧縮ファイルを配信
        gzip_static on;
    }

    # 最新版: 1時間キャッシュ
    location ~* ^/widget\.(latest|js)(\.min\.js)?$ {
        add_header Cache-Control "public, max-age=3600, stale-while-revalidate=300";
        add_header X-Content-Type-Options nosniff;
        add_header Access-Control-Allow-Origin *;
        expires 1h;
        gzip_static on;
    }

    # .gz ファイルの Content-Encoding 設定
    location ~* \.js\.gz$ {
        add_header Content-Encoding gzip;
        default_type application/javascript;
        gzip off;  # 二重圧縮を防ぐ
        add_header Cache-Control "public, max-age=31536000, immutable";
        add_header Access-Control-Allow-Origin *;
    }

    # OPTIONS preflight
    location / {
        if ($request_method = 'OPTIONS') {
            add_header Access-Control-Allow-Origin *;
            add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS";
            add_header Access-Control-Max-Age 86400;
            add_header Content-Length 0;
            return 204;
        }
    }
}
```

---

## キャッシュ戦略まとめ

| リソース | Cache-Control | CDN TTL | 理由 |
|----------|--------------|---------|------|
| `widget.v*.min.js` | `public, max-age=31536000, immutable` | 1年 | バージョン固定で内容変化なし |
| `widget.latest.min.js` | `public, max-age=3600, stale-while-revalidate=300` | 1時間 | 最新版参照、適度な鮮度 |
| `widget.js`（開発用） | `public, max-age=300` | 5分 | 開発環境での頻繁な更新 |
| `/api/*` | `no-store, no-cache` | バイパス | 動的コンテンツ |
| `/dialog/*` | `no-store, no-cache` | バイパス | セッション依存 |
| `/health` | `no-store` | バイパス | リアルタイム状態 |

---

## デプロイフロー（Widget更新時）

```
1. バージョン番号を決定（例: 1.1.0）
2. bash SCRIPTS/build-widget.sh 1.1.0
3. rsync dist/widget/ user@65.108.159.161:/var/www/cdn/widget/
4. Cloudflare でキャッシュパージ（Purge Everything は非推奨）
   → Cloudflare → Caching → Configuration → Custom Purge
   → URL: https://cdn.rajiuce.com/widget.latest.min.js のみパージ
5. クライアントの埋め込みタグのバージョン番号を更新
```

> **immutable キャッシュのため、バージョン付きファイルはパージ不要。**
> `widget.v1.0.0.min.js` はキャッシュを破壊せず永遠にキャッシュされる。

---

## HTTPS 強制設定

### Cloudflare 側

- Always Use HTTPS: **ON**
- HTTP Strict Transport Security (HSTS): max-age=31536000; includeSubDomains

### API サーバ側（既存 — 変更不要）

`src/lib/headers.ts` に以下が設定済み：

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

---

## セキュリティヘッダー差分

`SCRIPTS/security-headers.ts` を実行して差分を確認できます。

```bash
pnpm tsx SCRIPTS/security-headers.ts
```

**追加推奨ヘッダー（`src/lib/headers.ts` への追記を統合役に依頼）:**

| ヘッダー | 推奨値 | 理由 |
|----------|--------|------|
| `X-XSS-Protection` | `1; mode=block` | 旧式ブラウザのXSSフィルター有効化 |
| `Cross-Origin-Opener-Policy` | `same-origin-allow-popups` | Spectre攻撃対策 |
| `Cross-Origin-Resource-Policy` | `cross-origin` | Widget/CDNからのAPIアクセス許可 |
| `X-DNS-Prefetch-Control` | `off` | DNS情報漏洩リスク軽減 |

---

## トラブルシューティング

### widget.js が更新されない

1. Cloudflare キャッシュをパージ: `Custom Purge` → widget.latest.min.js の URL
2. ブラウザキャッシュをクリア（Hard Reload: Ctrl+Shift+R）
3. `widget.v<バージョン>.min.js` の URL に変更してバージョン固定にする

### CORS エラーが出る

1. ウィジェット埋め込み先のオリジンが `ALLOWED_ORIGINS` に含まれているか確認
2. API サーバの CORS 設定を確認: `src/lib/cors.ts`
3. Cloudflare の Transform Rules で `Access-Control-Allow-Origin` が正しく設定されているか確認

### gzip ファイルが二重圧縮される

1. Nginx の `gzip_static on` が設定されているか確認
2. `.gz` ファイルの location ブロックで `gzip off` が設定されているか確認
3. Cloudflare の「Compression」設定を確認（自動 gzip が .gz ファイルに適用されている場合は無効化）

---

## 関連ファイル

| ファイル | 説明 |
|----------|------|
| `public/widget.js` | ウィジェット本体（ソース） |
| `SCRIPTS/build-widget.sh` | Widget ビルド・最適化スクリプト |
| `SCRIPTS/tz-middleware-template.ts` | タイムゾーンミドルウェアテンプレート |
| `SCRIPTS/cors-config-template.ts` | CORS設定テンプレート |
| `SCRIPTS/security-headers.ts` | セキュリティヘッダー差分確認ツール |
| `src/lib/headers.ts` | APIサーバセキュリティヘッダー実装 |
| `src/lib/cors.ts` | APIサーバCORS実装 |
| `docs/DEPLOY_CHECKLIST.md` | デプロイチェックリスト |
