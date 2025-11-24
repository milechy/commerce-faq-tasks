# 検索パイプライン – ES + pgvector ハイブリッド

`/agent.search` から呼ばれる検索パイプラインの詳細です。

## 全体フロー

1. クエリ正規化（Planner）
2. Elasticsearch 検索（BM25）
3. pgvector 類似検索（HNSW）
4. スコア正規化＆マージ
5. 再ランキング（Reranker）
6. LLM による回答生成（Synthesis）

---

## 1. Planner – クエリ正規化

- 入力: ユーザーの生クエリ `q`
- 出力:
  - `searchQuery`: ES / pgvector で使うキーワード
  - `topK`: 最終的に使う候補数
  - `filters`: カテゴリなどのフィルタ条件

例: `"送料について教えて"` → `"送料"` + `category = shipping`

Planner は現状 rule-based で実装されており、将来的に LLM ベース Planner に差し替え可能です。

---

## 2. Elasticsearch – テキスト検索

- Index: `faqs`
- 検索条件:
  - `tenant_id` でフィルタ
  - `question`, `answer`, `tags` などへの full-text query
- 出力フォーマット（一例）:

```json
{
  "id": "CSQSpZoBKf6L66OCmmve",
  "text": "当店の送料は全国一律500円です。沖縄・離島は別料金となります。",
  "score": 0.3197,
  "source": "es"
}
```

---

## 3. pgvector – 意味検索

PostgreSQL + pgvector で FAQ Embedding を類似検索します。

### クエリの流れ

1. Embedding API でクエリ文 `q` をベクトル化
2. `faq_embeddings` を対象に HNSW インデックスで近傍探索
3. `tenant_id` でフィルタ
4. コサイン距離を類似度スコア（0〜1）に変換

### SQL 例

```sql
SELECT
  id::text,
  text,
  1 - (embedding <-> $1::vector) AS score
FROM faq_embeddings
WHERE tenant_id = $2
ORDER BY embedding <-> $1::vector
LIMIT $3;
```

- `$1` … クエリベクトル
- `$2` … `tenant_id`
- `$3` … 上限件数

### HNSW インデックス

```sql
CREATE INDEX IF NOT EXISTS faq_embeddings_embedding_hnsw_cosine
  ON faq_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

ANALYZE faq_embeddings;
```

---

## 4. スコア正規化＆マージ

- ES 由来: `source = "es"`, `score` は BM25 スコアを 0〜1 に再スケーリング（実装依存）
- pgvector 由来: `source = "pgvector"`, `score = 1 - distance` （距離 0 が 1.0 に近くなる）

マージ戦略（シンプル版）:

1. 両方のソースから上位 N 件を取得
2. `score` を共通 0〜1 スケールに変換
3. 同一テキスト / 同一 FAQ に対するヒットは max スコア or 加重平均で統合
4. ソース種別を保持したまま、1 本のリストにまとめる

---

## 5. 再ランキング（Reranker）

現状は **ヒューリスティックな Reranker** を使用:

- questions / answers の長さ
- ES / pgvector どちらから来たか
- カテゴリ一致度

などの簡易ルールでスコアを微調整し、`topK` 件を最終候補として返します。

将来的には LLM ベースの Reranker（cross-encoder 等）に差し替え可能です。

---

## 6. 回答生成（Synthesis）

Reranker の上位候補を、LLM にプロンプトとして渡して回答文を生成します。

- 入力:
  - ユーザー質問 `q`
  - 上位 FAQ 候補（question, answer, score など）
- 出力:
  - `answer`: 人間向けの自然な回答
  - （オプション）引用元 FAQ の一覧

エージェントの会話トーンや構成（セールス寄り / FAQ 寄り）は、
プロンプトテンプレートや将来の "会話フローテンプレート" でチューニングする想定です。
