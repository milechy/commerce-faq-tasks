

# DB スキーマ – commerce_faq

PostgreSQL データベース `commerce_faq` に作成される主要なテーブルをまとめます。

## 1. `faq_docs` – FAQ のソース・オブ・トゥルース

管理 UI / Admin API から直接編集されるテーブルです。Elasticsearch や pgvector は、このテーブルの内容をもとに同期されます。

```sql
CREATE TABLE IF NOT EXISTS faq_docs (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  TEXT        NOT NULL,
  question   TEXT        NOT NULL,
  answer     TEXT        NOT NULL,
  category   TEXT,
  tags       TEXT[]      DEFAULT '{}',
  is_published BOOLEAN   NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS faq_docs_tenant_id_idx
  ON faq_docs (tenant_id);

CREATE INDEX IF NOT EXISTS faq_docs_tenant_category_idx
  ON faq_docs (tenant_id, category);
```

> 2026-08-25 是正: `es_doc_id` 列はコードから既に参照が無く、DROP migration
> (`src/api/admin/knowledge/migration_drop_es_doc_id.sql`)を用意済み(未適用。
> 適用は運用タスク)。ES ドキュメントIDは `faqEsDocId(tenantId, faqId)`
> (`src/lib/knowledge/faqIndexSync.ts`)で `${faqId}_${tenantId}` として算出する
> 規約に統一されており、専用列は不要。
>
> `is_global` 列も同様に是正対象(このドキュメントの「グローバル知識」節を参照)。

### カラム説明

- `tenant_id`
  - テナント識別子（例: `demo`）
- `question`
  - FAQ の質問文
- `answer`
  - FAQ の回答文
- `category`
  - カテゴリ（例: `shipping`, `payment` など）
- `tags`
  - 任意のタグ配列（UI でのフィルタなどに利用予定）
- `is_published`
  - 公開フラグ。`false` のものは `/api/chat` の検索から除外される
    (`src/search/pgvector.ts` の `FAQ_VISIBILITY_WHERE`)。

### グローバル知識(is_global 列は使わない)

全テナント共通の知識は `faq_docs.tenant_id = 'global'` または `'r2c_docs'` の行として
実装されている(`src/search/pgvectorSearch.ts`)。`migration_add_is_global.sql` で
追加された `faq_docs.is_global` 列は読み手も書き手も無い死列で、DROP migration
(`src/api/admin/knowledge/migration_drop_is_global.sql`)を用意済み(未適用)。


## 2. `faq_embeddings` – pgvector 用ベクトルテーブル

FAQ ごとのベクトルを管理し、pgvector で類似検索するためのテーブルです。

```sql
CREATE TABLE IF NOT EXISTS faq_embeddings (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT        NOT NULL,
  faq_id      BIGINT     NOT NULL,
  text        TEXT       NOT NULL,
  embedding   VECTOR(1536) NOT NULL,
  metadata    JSONB
);

CREATE INDEX IF NOT EXISTS faq_embeddings_tenant_id_idx
  ON faq_embeddings (tenant_id);

CREATE INDEX IF NOT EXISTS faq_embeddings_embedding_hnsw_cosine
  ON faq_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

### カラム説明

- `tenant_id`
  - テナント識別子
- `faq_id`
  - 実体は BIGINT カラムだが、**`faq_docs.id` への外部キー制約は無い**。
    book / OCR / learned_memory 由来の行は `metadata.faq_id` を持たず
    (2026-08-25 ポストモーテム参照)、`faq_docs` と1:1対応するのは
    `metadata->>'faq_id'` が数値の行のみ。判定は `src/search/pgvector.ts` の
    `FAQ_VISIBILITY_JOIN` を一次情報とする。
- `text`
  - Embedding の元となったテキスト。FAQ由来は通常 `question + "\n" + answer`。
    暗号化設定時(`KNOWLEDGE_ENCRYPTION_KEY`)は暗号文が入る
    (`src/lib/crypto/textEncrypt.ts`)。
- `is_excluded_from_search`
  - BOOLEAN。true の行は `/api/chat` の検索対象から除外される
    (`src/migrations/phase69_2_excluded_ids.sql`)。列単位のupsertでこのフラグを
    引き継がず巻き戻す事故があったため、更新経路は `upsertFaqToEs` に
    フラグを明示的に渡すこと(`.claude/rules/knowledge.md` 参照)。
- `embedding`
  - pgvector のベクトル。次元数 1536 を前提
- `metadata`
  - JSONB。`source` は以下の値を取りうる: `faq`(FAQ由来)、`admin_agent`
    (`actionExecutor.ts` のチャットツール経由)、`book`(書籍取込)、
    `book:pdf:qwen-ocr`(OCR取込、`startsWith('book')`で書籍として判定される)。
    `faq_id` は上記のとおり数値のときだけ `faq_docs` と対応する。
  - 例:

```json
{
  "source": "faq",
  "faq_id": "1",
  "seededAt": "2025-11-22T00:37:59.888Z"
}
```

## 3. `faqs`(廃止済み・現存しない)

一部の初期フェーズで使われていたテーブルだが、現在は `faq_docs` に完全統合され、
`faqs` テーブル自体がコード上に存在しない(2026-08-25時点でgrep 0件)。
将来スキーマを検討する際にこのテーブルへの言及・再利用は不要。