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

## /search.v1 – RAG 検索 API（Phase17）

Phase17 では、RAG 検索レイヤの正準エンドポイントとして `/search.v1` を定義し、  
パイプラインとメトリクスの仕様を整理した。

### エンドポイント概要

- メソッド: `POST`
- パス: `/search.v1`
- 用途: FAQ・ナレッジ向けの RAG 検索（ハイブリッド検索 + 再ランク）
- 想定クライアント:
  - `/dialog/turn` 内部の検索呼び出し
  - ベンチ / 計測スクリプト（例: `SCRIPTS/bench-agent-search.ts`）

### リクエストスキーマ

```ts
type SearchV1Request = {
  q: string;
  topK?: number; // 1〜50, デフォルト 12
};
```

Zod スキーマ（実装準拠）:

```ts
const schemaIn = z.object({
  q: z.string(),
  topK: z.number().int().positive().max(50).optional(),
});
```

### レスポンススキーマ（概要）

```ts
type SearchV1Response = {
  items: Array<{
    id: string;
    text: string;
    score: number;
    source: "es" | "pg" | string;
  }>;
  meta: {
    route: string; // 例: "hybrid:es50+pg50"
    rerank_score: number | null;
    tuning_version: string; // 例: "v1"
    flags: string[]; // ["v1","validated","ce:active"|"ce:skipped", ...]
    ragStats?: {
      search_ms: number; // hybridSearch の所要時間
      rerank_ms?: number; // Cross-Encoder (ce_ms)
      total_ms: number; // search_ms + rerank_ms
    };
    hybrid_note?: string; // hybridSearch 内部のメトリクス文字列
  };
  ce_ms?: number; // rerank に要した時間（ms）
};
```

### パイプライン構成（/search.v1）

`/search.v1` の内部パイプラインはおおよそ次のとおり:

1. 入力バリデーション（Zod）
   - `q: string`
   - `topK?: number`（1〜50）
2. `hybridSearch(q)` の実行
   - Embedding 生成（LLM ベースの埋め込み。Phase17 では計測をまとめて `search_ms` に含める）
   - Elasticsearch 検索
   - pgvector 検索（Phase17 では無効化されているケースが多い）
   - マージ + ソート
   - 内部メトリクスの組み立て:
     - `note: "search_ms=... es_ms=... es_hits=... pg_hits=..."` 形式の文字列
3. `rerank(q, results.items, k)` の実行
   - Cross-Encoder による再ランク。
   - Phase17 時点では `engine: "dummy"` で、実質 no-op に近い軽量処理。
   - 将来 ONNX ランタイムを利用した Cross-Encoder に差し替える想定。
4. メタ情報の組み立てとレスポンス返却
   - `route`: `"hybrid:es50+pg50"` など、パイプラインルートの識別子。
   - `flags`:
     - `"v1"`: `/search.v1` であること
     - `"validated"`: Zod によるバリデーション済みであること
     - `"ce:active"` / `"ce:skipped"`: CE の有効/無効を表すフラグ
   - `ragStats`:
     - `search_ms`: `hybridSearch` に要した時間（ms）
     - `rerank_ms`: `ce_ms` をそのまま反映（Phase17 では ~1ms）
     - `total_ms`: `search_ms + rerank_ms`
   - `hybrid_note`:
     - `pg_fts:...` や `search_ms`, `es_ms`, `es_hits`, `pg_hits` など、
       hybridSearch 内部で計測したメトリクス文字列。

### メトリクスの扱い

Phase17 時点での代表的な `/search.v1` 計測値（ベンチ N=100）:

- RAG レイテンシ:
  - `ragStats.total_ms p50/p95 ≒ 626 / 652 ms`
- 内訳:
  - `search_ms p50/p95 ≒ 625 / 651 ms`
  - `rerank_ms p50/p95 ≒ 1 / 1 ms`（dummy CE）
  - `hybrid_note` から、`search_ms` と `es_ms` はほぼ一致し、多くのクエリで RAG のほとんどの時間が ES 検索に費やされていることが分かる。
  - `pg_hits=0` のケースでは pgvector 部分のコストはゼロ。

このため、Cross-Encoder ONNX 導入後の最適化では、

- `search_ms` を大きく悪化させないこと（ES 側のチューニング）
- `rerank_ms p95` を 100〜150ms 程度に抑えること
- pgvector を有効化した際にも `es_ms` / `pg_ms` の内訳を見ながら分担を調整すること

がパフォーマンス設計上の重要なポイントとなる。

### 今後の拡張ポイント（メモ）

- `hybrid_note` を構造化メトリクス（例: `meta.ragStats.es_ms`, `meta.ragStats.pg_ms`）に昇格させる。
- `/dialog/turn` 側で、`/search.v1` の `ragStats` をそのままログ・メトリクスに取り込む。
- 複数の route（例: `"es-only"`, `"pg-only"`, `"hybrid:es+pg"`）を定義し、`meta.route` に反映させる。
