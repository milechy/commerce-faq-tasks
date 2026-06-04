# Phase69-2-D: faq_embedding orphan 調査レポート

調査日: 2026-05-31  
担当: CLI Lane (GID 1214820948023240)  
実機作業: hkobayashi (VPS 手動 SQL 実行)

---

## 1. 事象

Phase69-2-A Round3 の VPS DB 調査で、`faq_embeddings` テーブルに orphan 行を 1件検出。

検出 SQL:
```sql
SELECT fe.id, fe.tenant_id, fe.metadata
FROM faq_embeddings fe
LEFT JOIN faq_docs fd ON fd.id = (fe.metadata->>'faq_id')::bigint
WHERE fe.metadata->>'faq_id' ~ '^[0-9]+$' AND fd.id IS NULL;
```

`fe.metadata->>'faq_id'` が指す `faq_docs` 行が存在しない = orphan。

---

## 2. 根本原因の調査結果

### 2-A. DB 制約（ON DELETE CASCADE）の有無

**結論: DB 制約なし。**

- `docs/sql/0002_faq_embeddings_pgvector.sql` — `faq_embeddings` テーブル定義。`faq_id` 列が存在せず、faq_id は `metadata JSONB` 内の `metadata->>'faq_id'` として格納されている。
- `docs/db-schema.md` には将来の理想形として `faq_id BIGINT NOT NULL REFERENCES faq_docs(id)` が記載されているが、**実際の DDL には存在しない**。
- 全マイグレーション SQL (`src/migrations/*.sql`) に `FOREIGN KEY ... faq_docs` への参照なし。
- `ON DELETE CASCADE` は `faq_embeddings <-> faq_docs` 間には一切設定されていない。

### 2-B. アプリ層の連鎖削除の有無

**結論: 新ルートは実装済み。旧ルートが欠落。**

| エンドポイント | ファイル | faq_embeddings 削除 |
|---|---|---|
| `DELETE /v1/admin/knowledge/:id` | `src/api/admin/knowledge/routes.ts:396` | あり (`metadata->>'faq_id'` で削除) |
| `DELETE /v1/admin/knowledge/faq/:id` | `src/api/admin/knowledge/faqCrudRoutes.ts:592` | あり (`metadata->>'faq_id'` で削除) |
| `DELETE /v1/admin/knowledge/faq/bulk` | `src/api/admin/knowledge/faqCrudRoutes.ts:524` | あり (トランザクション内で削除) |
| **`DELETE /admin/faqs/:id`** | **`src/admin/http/faqAdminRoutes.ts:426`** | **なし（欠落）** |

`faqAdminRoutes.ts:437` にはコメントが残っている:
```typescript
// embeddings 側を faq_id などで紐付けるようにしたら、ここで一緒に削除
```
これは「TODO のまま放置された」状態。このエンドポイントが本番で使用された時に orphan が発生したと推定される。

### 2-C. orphan 発生経路の推定

```
1. POST /admin/faqs で FAQ 作成 → faq_docs + faq_embeddings (metadata.faq_id) を挿入
2. DELETE /admin/faqs/:id で FAQ 削除 → faq_docs のみ削除、faq_embeddings は残る
3. faq_embeddings が orphan 化
```

---

## 3. 対応方針

### 3-1. 今回の orphan クリーンアップ（hkobayashi 手動実行）

手順: `src/migrations/phase69_2d_faq_embedding_orphan_cleanup.sql` を参照。

```
Step 1: orphan 検出確認 → Step 2: DELETE トランザクション → Step 4: 0件確認
```

### 3-2. 再発防止（優先度順）

#### 優先度 HIGH: 旧ルートの連鎖削除欠落を修正

`src/admin/http/faqAdminRoutes.ts` の `DELETE /admin/faqs/:id` に、faq_embeddings の削除を追加する。

修正案（アプリ層、今後の PR で対応）:
```typescript
// faq_docs 削除前に faq_embeddings を削除
await db.query(
  `DELETE FROM faq_embeddings
   WHERE tenant_id = $1
     AND (metadata->>'faq_id')::bigint = $2`,
  [tenantId, id]
);
// 既存の faq_docs 削除
// DELETE FROM faq_docs WHERE id = $1 AND tenant_id = $2 ...
```

#### 優先度 MEDIUM: DB 制約（将来対応）

`faq_embeddings` に `faq_doc_id BIGINT REFERENCES faq_docs(id) ON DELETE CASCADE` 列を追加することで DB レベルで保証できる。ただし:
- 既存の `metadata->>'faq_id'` を物理列に移行するデータマイグレーションが必要
- book/web 等の非 FAQ embedding (faq_id なし) の扱いを考慮する必要がある
- このマイグレーションは大規模かつリスクが高いため、別 Phase で計画的に実施推奨

**今回の判断: DB 制約追加は「将来対応」として scope 外。アプリ層の連鎖削除欠落補完を優先とする。**

理由:
- `metadata JSONB` 内の文字列 faq_id に FK 制約は追加不可
- 物理列追加は破壊的変更でありリスクが高い
- 既に新ルート（`/v1/admin/knowledge/` 系）はアプリ層で連鎖削除を実装済み
- 旧ルート (`/admin/faqs/:id`) の修正のほうがコスト対効果が高い

---

## 4. hkobayashi 手動作業（VPS）

### 4-1. 事前バックアップ

```bash
psql $DATABASE_URL -c "\
COPY (SELECT * FROM faq_embeddings WHERE metadata->>'faq_id' ~ '^[0-9]+\$') \
  TO '/tmp/faq_embeddings_backup_$(date +%Y%m%d).csv' CSV HEADER;"
```

### 4-2. orphan 検出確認

```sql
SELECT fe.id, fe.tenant_id, fe.metadata
FROM faq_embeddings fe
LEFT JOIN faq_docs fd ON fd.id = (fe.metadata->>'faq_id')::bigint
WHERE fe.metadata->>'faq_id' ~ '^[0-9]+$' AND fd.id IS NULL;
```

0件なら既に解消済みのため以降の削除不要。

### 4-3. orphan 削除（1件確認後に実行）

```sql
BEGIN;

DELETE FROM faq_embeddings fe
WHERE fe.metadata->>'faq_id' ~ '^[0-9]+$'
  AND NOT EXISTS (
    SELECT 1 FROM faq_docs fd
    WHERE fd.id = (fe.metadata->>'faq_id')::bigint
  );

COMMIT;
```

### 4-4. 削除後確認

```sql
SELECT COUNT(*) AS orphan_count
FROM faq_embeddings fe
LEFT JOIN faq_docs fd ON fd.id = (fe.metadata->>'faq_id')::bigint
WHERE fe.metadata->>'faq_id' ~ '^[0-9]+$' AND fd.id IS NULL;
-- 期待値: 0
```

---

## 5. 関連ファイル

| ファイル | 役割 |
|---|---|
| `src/migrations/phase69_2d_faq_embedding_orphan_cleanup.sql` | クリーンアップ + 将来の CASCADE テンプレート |
| `src/admin/http/faqAdminRoutes.ts:426` | 旧ルート (faq_embeddings 削除欠落) |
| `src/api/admin/knowledge/routes.ts:396` | 新ルート (連鎖削除実装済み) |
| `src/api/admin/knowledge/faqCrudRoutes.ts:592` | 新ルート (連鎖削除実装済み) |
| `docs/sql/0002_faq_embeddings_pgvector.sql` | faq_embeddings テーブル定義 (FK なし) |
| `docs/db-schema.md` | 理想スキーマ記載 (faq_id 物理列、未実装) |
