

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
  es_doc_id  TEXT,                 -- Elasticsearch の _id
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

### カラム説明

- `tenant_id`
  - テナント識別子（例: `demo`）
- `question`
  - FAQ の質問文
- `answer`
  - FAQ の回答文
- `category`
  - カテゴリ（例: `shipping`, `payment` など）
- `es_doc_id`
  - Elasticsearch `faqs` インデックス上の `_id`
- `tags`
  - 任意のタグ配列（UI でのフィルタなどに利用予定）
- `is_published`
  - 公開フラグ。`false` のものは `/agent.search` などから除外する設計を想定


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
  - `faq_docs.id` と 1:1 対応させる想定（または将来の `faqs` テーブル）
- `text`
  - Embedding の元となったテキスト（通常は `question + "\n" + answer`）
- `embedding`
  - pgvector のベクトル。次元数 1536 を前提
- `metadata`
  - JSONB。以下のようなメタ情報を格納:
  - 例:

```json
{
  "source": "faq",
  "faq_id": "1",
  "seededAt": "2025-11-22T00:37:59.888Z"
}
```

### 注意: 既存 seed データ

- 開発初期に `faq_embeddings` に直接 seed されたデータが存在する場合があります（`metadata.source = 'groq/compound-mini'` など）。
- `metadata.source = 'faq'` かつ `metadata.faq_id` が付いている行は Admin API によって生成された新しい行です。


## 3. （オプション）`faqs` – 旧設計テーブル

一部のフェーズで使用した旧テーブル。現在は `faq_docs` をメインとして利用していますが、履歴として記載しておきます。

```sql
CREATE TABLE IF NOT EXISTS faqs (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT        NOT NULL,
  question    TEXT        NOT NULL,
  answer      TEXT        NOT NULL,
  category    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS faqs_tenant_id_idx
  ON faqs (tenant_id);
```

将来的にスキーマを整理する際には、`faq_docs` に完全統合するか、`faqs` を正式なメインテーブルとして使うかを再検討してください。