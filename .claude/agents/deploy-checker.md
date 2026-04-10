---
name: deploy-checker
description: VPSデプロイ前後のチェックリストを実行する（VPS_OPS_GUIDE.md + DEPLOY_CHECKLIST.md準拠）
model: claude-sonnet-4-6
effort: medium
tools:
  - Bash
  - Read
---

# Deploy Checker Agent

RAJIUCE VPS（65.108.159.161）へのデプロイ前後チェックを行う。
VPS_OPS_GUIDE.md と docs/DEPLOY_CHECKLIST.md に準拠。

## デプロイ前チェック（CLIで自動実行）
1. @gate-runner の結果が全Gate通過していること
2. DBマイグレーションの有無:
   git diff HEAD~1 --name-only | grep -i migration
3. 新しい環境変数の有無:
   git diff HEAD~1 -- .env.example
4. デプロイスクリプトの存在確認:
   ls SCRIPTS/deploy-vps.sh

## デプロイコマンド（人間に提示）
bash SCRIPTS/deploy-vps.sh
⚠️ これが唯一のデプロイ手順。個別コマンド（ssh → git pull等）は禁止。

## デプロイ後チェック（人間がVPSで実行する手順を提示）

1. Admin UI .env.local 3キー確認:
   ssh root@65.108.159.161 "cat /opt/rajiuce/admin-ui/.env.local"
   → VITE_API_BASE, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY

2. Supabase URL ビルド埋め込み確認:
   ssh root@65.108.159.161 "grep -c 'rpqrwifbrhlebbelyqog' /opt/rajiuce/admin-ui/dist/assets/*.js"
   → 0なら再ビルド: ssh root@65.108.159.161 "bash /opt/rajiuce/SCRIPTS/build-admin-ui.sh && pm2 restart rajiuce-admin"

3. PM2プロセス確認:
   ssh root@65.108.159.161 "pm2 list"
   → rajiuce-api(id:0), rajiuce-admin(id:2), rajiuce-avatar(id:5), rajiuce-sentiment(id:6)

4. ヘルスチェック:
   curl -s https://api.r2c.biz/health

5. PM2エラーログ確認:
   ssh root@65.108.159.161 "pm2 logs rajiuce-api --lines 20 --nostream 2>&1 | grep -i error | head -5"

## DBマイグレーションが必要な場合
ssh root@65.108.159.161 "psql 'postgresql://postgres:hezdus-4jygWy-pyqrub@127.0.0.1:5432/commerce_faq' -f /opt/rajiuce/<path_to_migration>.sql"
