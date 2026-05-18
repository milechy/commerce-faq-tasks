# Lane Template: Tier A — DB Schema (migration SQL 記述のみ)

## 推奨モデル: Opus 4.7

DB migration SQL の **新規記述** を担当するタスク用テンプレ。
**apply は Tier S (hkobayashi 手動)**。このテンプレでは SQL ファイルの作成と確認クエリの添付のみ行う。

指示文 v1 §11 で **Tier A (auto-merge 不可)**。
`custom_field gate_2_5_required = true` 必須。

---

## Step 0: 必読 (省略禁止 — 鉄則 8)

タスク着手前に以下を `cat` で読み込み、内容を踏まえて作業すること。

```bash
cat CLAUDE.md
cat docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md
cat docs/R2C_DEVELOPMENT_PLAYBOOK.md
# DB 関連
ls migrations/ 2>/dev/null || ls db/migrations/ 2>/dev/null || ls supabase/migrations/ 2>/dev/null
# 既存 schema 規約を確認 (RLS / tenant_id / created_at 等)
ls .claude/skills/r2c-tenant-isolation/
```

既存の最新 migration を 2-3 個 `cat` で読み、命名規則 / RLS 適用パターン / index 命名規則を踏襲。

---

## Tier 判定 (changedFiles 自動チェック)

実装着手前と Gate 直前の 2 回、以下を実行して Tier が変わっていないことを確認。

```bash
git diff --name-only main...HEAD
```

判定ルール:

| 変更ファイル | Tier | このテンプレ適用 |
|---|---|---|
| migration SQL の **新規ファイル追加のみ** (apply しない) | **A (schema)** | このテンプレ |
| migration を `psql` / Supabase CLI で **本番 apply** する手順を含む | **S** | tier-s-prod に切替 |
| `src/api/**` の route / handler 変更を同時に行う | A (api) | tier-a-api 併用 |
| `.env*`, `SCRIPTS/deploy-vps.sh` を編集 | **S** | tier-s-prod に切替 |

**重要**: このテンプレは「SQL ファイル」と「確認クエリ」の納品まで。
apply 手順を CLI が実行することは禁止 (deploy_guard / 本番影響のため)。

---

## 必須実装ルール (rajiuce 固有)

- **tenant_id カラム**: 全 tenant-scoped テーブルに `tenant_id TEXT NOT NULL` を必ず追加
- **RLS (Row Level Security)**: 既存 pattern に合わせて enable + policy 定義
- **index**: `tenant_id` を含む複合 index を必ず付与 (検索の前段 prune)
- **migration 命名**: `YYYYMMDD_<short-description>.sql` (既存に合わせる)
- **rollback SQL** を同 migration ファイル内にコメントで記載 (`-- ROLLBACK:` セクション)
- **destructive 操作** (DROP TABLE / DROP COLUMN / TRUNCATE) は別 migration に分け、Team Lead 承認必須
- データ移行を含む migration は **idempotent** にする (`IF NOT EXISTS` / `ON CONFLICT` 等)

---

## 確認クエリ (PR description に必ず添付)

migration が期待通り動いたかを apply 担当者 (hkobayashi) が手動確認できるよう、以下をテンプレに用意して PR に添付:

```sql
-- 適用後確認: 新規テーブル / カラムの存在
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = '<table>'
 ORDER BY ordinal_position;

-- RLS 有効化確認
SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class
 WHERE relname = '<table>';

-- index 確認
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE tablename = '<table>';

-- テナント分離サンプル (super_admin で全件、client_admin で自テナント分のみ見えること)
SELECT tenant_id, count(*) FROM <table> GROUP BY tenant_id;
```

---

## Gate (実装完了後)

### Gate 1: pnpm verify
```bash
pnpm verify
```
- SQL 単独追加なら typecheck/lint/test は通常影響なし
- schema 連動の TypeScript types (drizzle/prisma 等) を更新した場合は typecheck 必須
報告フォーマット:
```
## Gate 1: pnpm verify
- typecheck: PASS / FAIL (n errors)
- lint: PASS / FAIL (n warnings)
- test: PASS / FAIL (n failures)
```

### Gate 1.5: schema 整合性チェック
- migration 番号 (YYYYMMDD) が既存の最大値より大きいこと
- `tenant_id` カラム有無を grep で確認
- destructive 操作の有無を grep で確認 (`DROP TABLE`, `DROP COLUMN`, `TRUNCATE`)
- dead-code-check 該当なし

### Gate 2: security-scan
```bash
bash SCRIPTS/security-scan.sh
```
- SQL injection 余地 / 平文 secrets 混入なし確認
- High/Critical: 0 件

### Gate 3: build
```bash
pnpm build && cd admin-ui && pnpm build && cd ..
```
- types を更新した場合のみ意味あり。SQL only の場合は影響なしを記述

### Gate 2.5: Codex review (必須)
- `/codex:review --base main --background` → `/codex:result` (push 前)
- 特にテナント分離 / RLS / destructive 操作の有無を重点レビュー
- セキュリティ系 → 追加で `/codex:adversarial-review --background`
- Critical/High → 修正 → Gate 1 から再実行

---

## Acceptance Criteria (DoD)

- [ ] migration SQL ファイルが命名規則に準拠
- [ ] tenant-scoped テーブルに `tenant_id` + RLS + 複合 index 完備
- [ ] rollback SQL がコメントで記載
- [ ] destructive 操作なし (あれば別 PR に分割)
- [ ] PR description に確認クエリ 4 種 (カラム / RLS / index / テナント分離) 添付
- [ ] Gate 1-3 PASS / Gate 2.5 Critical/High ゼロ
- [ ] apply 手順 (hkobayashi 手動実行) を PR description に明記

---

## 一切しないこと

- 本番 DB への apply (psql / supabase db push / migrate up) — Tier S に分割
- `.env*` / 接続文字列の編集 (Tier S)
- destructive 操作と additive 操作を同一 migration に混在
- `tenant_id` なしの tenant-scoped テーブル作成
- RLS を意図的に disable
- 他 teammate 担当ファイル / `src/api/` 配下の編集 (必要なら tier-a-api と併用 PR)
- SSH コマンドを手順書に書く (deploy_guard.py がブロック)
- main ブランチへの直接 commit / push
- auto-merge enable (Tier A は朝承認・人間判断)

---

## 最終アクション

1. `git add <migration sql ファイル>` (`git add -A` 禁止)
2. `git status` で他ファイル混入なし確認
3. `git commit -m "feat(db): add <table> migration (apply pending)"` (Co-Authored-By 行を含める)
4. `/codex:review --base main --background` → `/codex:result` (push 前)
5. `git push -u origin feature/<asana-gid>-<short-description>`
6. `gh pr create --title "feat(db): add <table> migration" --body "<DoD + 確認クエリ 4 種 + apply 手順 + Asana GID>"`
7. **auto-merge は enable しない** (Tier A、apply は別 PR で hkobayashi 手動)
8. PR URL + migration ファイル名 + 確認クエリ要点を 1 行で報告
