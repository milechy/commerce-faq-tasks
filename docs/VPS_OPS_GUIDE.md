# VPS Operations Guide

VPS: `65.108.159.161` (Hetzner)
API port: `3100` / Admin UI port: `5173`

## DBマイグレーション一覧

VPSのPostgreSQLに対して手動で適用するSQLファイルの一覧。

```bash
# 実行方法（VPS上で）
psql $DATABASE_URL -f /opt/rajiuce/<ファイルパス>
```

| ファイル | 対象テーブル (操作) | 導入フェーズ |
|---|---|---|
| `src/api/admin/feedback/migration_feedback.sql` | `feedback_messages` (CREATE) | Phase 35+ |
| `src/api/admin/feedback/migration_feedback_flagged.sql` | `feedback_messages` (ALTER) | Phase 38+ |

## よく使うオペレーションコマンド

### PM2

```bash
pm2 list                          # プロセス一覧
pm2 logs rajiuce-api --lines 50   # APIログ
pm2 logs rajiuce-admin --lines 20 # Admin UIログ
pm2 restart rajiuce-api           # API再起動
pm2 restart rajiuce-admin         # Admin UI再起動
pm2 restart all                   # 全プロセス再起動
```

### デプロイ（ローカルから）

```bash
# 全体デプロイ
bash SCRIPTS/deploy-vps.sh

# フロントのみ再ビルド・再起動
ssh root@65.108.159.161 "bash /opt/rajiuce/SCRIPTS/build-admin-ui.sh && pm2 restart rajiuce-admin"

# バックエンドのみ再ビルド・再起動
ssh root@65.108.159.161 "cd /opt/rajiuce && git pull origin main && pnpm build && pm2 restart rajiuce-api"
```

### ログ・モニタリング

```bash
# ヘルスチェック
curl http://65.108.159.161:3100/health

# Prometheusメトリクス
curl -H "X-Internal-Request: 1" http://65.108.159.161:3100/metrics

# DBサイズ確認
ssh root@65.108.159.161 "psql \$DATABASE_URL -c \"SELECT pg_size_pretty(pg_database_size(current_database()));\""
```
