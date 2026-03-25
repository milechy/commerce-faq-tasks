# VPS 運用ガイド — よくあるトラブルと注意点

> 2026-03-18 作成。実際のインシデント対応から得られた教訓を文書化。
> VPS: `root@65.108.159.161` | Project: `/opt/rajiuce`

---

## 1. デプロイ後の必須確認事項

### 1.1 Admin UI の `.env.local` 確認

**背景:** Admin UI のビルドスクリプト（`SCRIPTS/build-admin-ui.sh`）は `.env.local` を最優先で読み、環境変数を `export` してから `pnpm build`（Vite）を実行する。このファイルがないか、必須キーが不足していると、Admin UI が「Supabase 未設定」エラーで動作しない。

**重要:** `.env.local` は `.gitignore` に含まれているため `git pull` / `rsync` では配布されない。VPS上で手動作成が必要。

**必須3キー:**

```
VITE_API_BASE=http://65.108.159.161:3100
VITE_SUPABASE_URL=https://rpqrwifbrhlebbelyqog.supabase.co
VITE_SUPABASE_ANON_KEY=<Supabaseダッシュボードから取得>
```

> ⚠️ `VITE_API_BASE` が漏れやすい。3つとも揃っていることを必ず確認する。

**毎回のデプロイ後に確認:**

```bash
# 1. ファイルが存在し、3キーすべて含まれているか
ssh root@65.108.159.161 "cat /opt/rajiuce/admin-ui/.env.local"
# → VITE_API_BASE, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY の3行があること

# 2. Supabase URL がビルド済み JS に埋め込まれているか
ssh root@65.108.159.161 "grep -c 'rpqrwifbrhlebbelyqog' /opt/rajiuce/admin-ui/dist/assets/*.js"
# → 0 なら再ビルドが必要
```

**ファイルがない / キーが不足している場合の復旧:**

```bash
ssh root@65.108.159.161 "cat > /opt/rajiuce/admin-ui/.env.local << 'EOF'
VITE_API_BASE=http://65.108.159.161:3100
VITE_SUPABASE_URL=https://rpqrwifbrhlebbelyqog.supabase.co
VITE_SUPABASE_ANON_KEY=<実際のキーをここに>
EOF"

# ビルドスクリプトで再ビルド（env検証 + ビルド後検証が含まれる）
ssh root@65.108.159.161 "bash /opt/rajiuce/SCRIPTS/build-admin-ui.sh && pm2 restart rajiuce-admin"
```

**なぜ `.env.production` ではなく `.env.local` か:**
`SCRIPTS/build-admin-ui.sh` は `.env.local` → `.env` の優先順で読み、環境変数を明示的に `export` してから Vite を実行する。`.env.production` は読まない。Vite 自体の env 読み込みに頼らず、ビルドスクリプトが制御している。

---

### 1.2 DB マイグレーションの実行確認

**背景:** 新しいテーブルやカラムを追加するコードがデプロイされても、DB スキーマは自動更新されない。マイグレーション SQL は手動実行が必要。

**デプロイ後にエラーログを確認:**

```bash
ssh root@65.108.159.161 "pm2 logs rajiuce-api --lines 50 --nostream 2>&1 | grep -i 'does not exist\|undefined_table\|42P01'"
```

**エラーが出た場合:**

```bash
# 1. 該当するマイグレーションファイルを探す
find src/ -name "*.sql" -path "*/migration*"

# 2. VPS で実行
ssh root@65.108.159.161 "psql 'postgresql://postgres:hezdus-4jygWy-pyqrub@127.0.0.1:5432/commerce_faq' -f /opt/rajiuce/<path_to_migration>.sql"
```

**既知のマイグレーション一覧:**

| ファイル | テーブル | Phase |
|---|---|---|
| `src/api/admin/knowledge/migration_knowledge_gaps.sql` | `knowledge_gaps` | Phase 38 |
| `src/api/admin/feedback/migration_feedback.sql` | `feedback_messages` (CREATE) | Phase 38 |
| `src/api/admin/feedback/migration_feedback_flagged.sql` | `feedback_messages` (ALTER) | Phase 38+ |
| `src/api/admin/chat-history/migration.sql` | `chat_sessions` / `chat_messages` | Phase 38 |
| `src/api/admin/tuning/migration.sql` | `tuning_rules` | Phase 38 |
| `src/api/admin/tuning/migration_system_prompt.sql` | `tenants.system_prompt` カラム追加（ALTER TABLE） | Phase 38 |
| `src/api/admin/knowledge/migration_book_uploads.sql` | `book_uploads` | Phase 44 |

> 新しいマイグレーションを追加した場合は、このテーブルを更新すること。

---

### 1.3 PM2 プロセス名の確認

**背景:** `pm2 env <name>` でプロセス名が一致しないとエラーになることがある。

```bash
# 正しいプロセス名を確認
ssh root@65.108.159.161 "pm2 list"

# 期待:
# rajiuce-api     (id: 0)
# rajiuce-admin   (id: 1)
# slack-listener  (id: 2)
```

プロセス名でコマンドが失敗する場合は ID で代用:

```bash
pm2 env 0        # rajiuce-api の環境変数
pm2 logs 0       # rajiuce-api のログ
pm2 restart 0    # rajiuce-api の再起動
```

---

## 2. デプロイ手順（再掲 + ガード）

### 基本ルール

> ⚠️ **必ず `bash SCRIPTS/deploy-vps.sh` を使用する。**
> 手動で `git pull` / `pnpm build` / `pm2 restart` を個別実行しない。
> Admin UI のビルド漏れによる空白画面の原因になる。

### Admin UI だけ再ビルドしたい場合

デプロイスクリプト全体を再実行せず、Admin UI だけ修正したい場合:

```bash
ssh root@65.108.159.161 "bash /opt/rajiuce/SCRIPTS/build-admin-ui.sh && pm2 restart rajiuce-admin"
```

このスクリプトは `.env.local` の読み込み → 必須キー検証 → ビルド → バンドル検証 を一括で行う。

### デプロイ後の最低限確認

```bash
# 1. API ヘルスチェック
curl -s http://65.108.159.161:3100/health | jq .status
# → "ok"

# 2. Admin UI が Supabase 環境変数を持っているか
ssh root@65.108.159.161 "grep -c 'rpqrwifbrhlebbelyqog' /opt/rajiuce/admin-ui/dist/assets/*.js"
# → 0 より大きい数値

# 3. PM2 エラーログ確認
ssh root@65.108.159.161 "pm2 logs rajiuce-api --lines 10 --nostream 2>&1 | grep -i error | head -5"
```

---

## 3. よくあるトラブルと対処法

### 3.1 Admin UI: 「Supabase 未設定」エラー

**原因:** `admin-ui/.env.local` がない、または必須キー（特に `VITE_API_BASE`）が不足したまま `pnpm build` が実行された。

**対処:** セクション 1.1 を参照。

---

### 3.2 Admin UI: 空白画面

**原因:** デプロイスクリプトで Admin UI の `pnpm build` がスキップされた、またはビルドがエラーで中断した。

**対処:**

```bash
# ビルド成果物が存在するか
ssh root@65.108.159.161 "ls /opt/rajiuce/admin-ui/dist/index.html"

# ビルドスクリプトで再ビルド
ssh root@65.108.159.161 "bash /opt/rajiuce/SCRIPTS/build-admin-ui.sh && pm2 restart rajiuce-admin"
```

---

### 3.3 PDF アップロード: GraphicsMagick エラー

**原因候補（優先順）:**

1. Admin UI の Supabase 未設定（3.1 を先に解決）
2. `pdf2pic` の依存 `gm` npm パッケージが未インストール
3. VPS に GraphicsMagick / Ghostscript バイナリがない

**診断:**

```bash
# gm バイナリ
ssh root@65.108.159.161 "which gm"

# Ghostscript
ssh root@65.108.159.161 "which gs"

# gm npm パッケージ（pnpm store 内）
ssh root@65.108.159.161 "ls /opt/rajiuce/node_modules/.pnpm/gm@*/node_modules/gm/package.json 2>/dev/null && echo 'OK' || echo 'MISSING'"

# pdf2pic → gm シンボリックリンク
ssh root@65.108.159.161 "ls -la /opt/rajiuce/node_modules/.pnpm/pdf2pic@*/node_modules/gm"
```

**gm npm パッケージがない場合:**

```bash
cd ~/Documents/GitHub/commerce-faq-tasks
pnpm add gm
pnpm add -D @types/gm
git add -A && git commit -m "fix: add gm explicitly"
git push origin main
bash SCRIPTS/deploy-vps.sh
```

**gm / gs バイナリがない場合:**

```bash
ssh root@65.108.159.161 "apt-get update && apt-get install -y graphicsmagick ghostscript"
```

---

### 3.4 DB: `relation "xxx" does not exist`

**原因:** マイグレーション未実行。セクション 1.2 を参照。

---

### 3.5 PM2 再起動ループ（↺ カウントが異常に高い）

**診断:**

```bash
ssh root@65.108.159.161 "pm2 list"
# ↺ 列が 100+ なら再起動ループの可能性

# 直近のエラーを確認
ssh root@65.108.159.161 "pm2 logs rajiuce-api --err --lines 30 --nostream"
```

**よくある原因:**

- 環境変数の不足（`DATABASE_URL`, `QWEN_API_KEY` など）
- `dist/src/index.js` が古い（`pnpm build` 漏れ）
- DB 接続失敗（PostgreSQL / Elasticsearch がダウン）

---

## 4. セキュリティ注意事項

### 4.1 書籍内容のログ漏洩防止

CLAUDE.md の Anti-Slop ルールにより、書籍・PDF の内容をログに出力してはいけない。

**対象ファイル:** `src/lib/ocrPipeline.ts`

```typescript
// ✅ 正しい（文字数のみ）
process.stdout.write(
  `[ocrPipeline] page ${pageNum}/${totalPages}: ${ocrText.length} chars extracted\n`
);

// ❌ 禁止（内容が漏れる）
process.stdout.write(
  `[ocrPipeline] page ${pageNum}/${totalPages}: ${ocrText.slice(0, 30)}...\n`
);
```

**確認コマンド:**

```bash
# ビルド済み JS にテキスト内容のログ出力がないか
ssh root@65.108.159.161 "grep 'slice(0' /opt/rajiuce/dist/src/lib/ocrPipeline.js"
# → 何も出力されないこと
```

### 4.2 `.env` ファイルの管理

- `.env`, `.env.production`, `.env.local` は `.gitignore` に含まれている
- Git リポジトリに秘匿情報を含めない
- VPS 上で直接作成・編集する
- Admin UI のビルドは `.env.local` を読む（`.env.production` ではない）
- バックアップは Vault または安全な場所に保管

---

## 5. デプロイ前チェックリスト（簡易版）

デプロイのたびに確認する最小限の項目:

```
□ bash SCRIPTS/deploy-vps.sh を使用した（手動 git pull 禁止）
□ VPS: admin-ui/.env.local に3キーすべて存在する
  - VITE_API_BASE
  - VITE_SUPABASE_URL
  - VITE_SUPABASE_ANON_KEY
□ VPS: curl health → "ok"
□ VPS: Admin UI にアクセスしてログイン画面が表示される
□ VPS: pm2 logs にエラーがない
□ 新しい SQL マイグレーションがある場合 → VPS の DB で実行済み
```

---

## 変更履歴

| 日付 | 内容 |
|---|---|
| 2026-03-18 | 初版作成。Supabase 未設定/GraphicsMagick エラー/knowledge_gaps マイグレーション漏れのインシデントから |
| 2026-03-18 | v2: `.env.production` → `.env.local` に修正。`build-admin-ui.sh` が `.env.local` を読むのが正。`VITE_API_BASE` 漏れの注意を追加 |
| 2026-03-24 | Phase38完了: chat_sessions / chat_messages / tuning_rules / tenants.system_prompt のマイグレーション一覧に追加 |
