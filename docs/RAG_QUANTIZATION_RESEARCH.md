# RAG メモリ効率化調査 — pgvector Quantization

**作成日:** 2026-04-06
**ステータス:** 調査・設計のみ（将来実装）
**実装タイムライン:** テナント拡大フェーズ（2027 H1 目標）まで保留

---

## 1. 現状分析

### faq_embeddings テーブルの推定サイズ

| テナント数 | 行数 (FAQあたり5問) | ベクトルサイズ | 概算テーブルサイズ |
|---|---|---|---|
| 1社 | ~500行 | 6,144 bytes/行 | ~3 MB |
| 10社 | ~5,000行 | 6,144 bytes/行 | ~30 MB |
| 100社 | ~50,000行 | 6,144 bytes/行 | ~300 MB |

**計算式:**
- `vector(1536)` × `float32` = 1536 × 4 bytes = **6,144 bytes/行**
- HNSW インデックスのオーバーヘッド: ベクトルデータの 1.5〜2 倍

### 現在の pgvector バージョン確認

```sql
SELECT extversion FROM pg_extension WHERE extname = 'vector';
```

pgvector 0.7.0 以降で `halfvec`（float16）型と Quantization サポートが強化された。

---

## 2. Binary Quantization (BQ)

### 概要

| 項目 | 値 |
|---|---|
| 圧縮率 | **32倍**（float32 → 1bit） |
| サイズ | 1536次元 → 192 bytes/行 |
| リコール精度 | 95% → 85-90% |
| pgvector対応 | 0.7.0+ (`bit` 型) |

### 実装例

```sql
-- bit 型カラム追加
ALTER TABLE faq_embeddings ADD COLUMN embedding_bq bit(1536);

-- 既存データを変換（閾値: 0 → bit 0, >0 → bit 1）
UPDATE faq_embeddings
SET embedding_bq = cast_to_bit(embedding);

-- ivfflat インデックス
CREATE INDEX ON faq_embeddings USING ivfflat (embedding_bq bit_hamming_ops)
  WITH (lists = 100);

-- HNSW インデックス
CREATE INDEX ON faq_embeddings USING hnsw (embedding_bq bit_hamming_ops)
  WITH (m = 16, ef_construction = 64);
```

### 検索例（2段階: BQ 粗検索 → float32 精密再ランク）

```sql
-- Step 1: BQ で上位200件を高速取得
WITH bq_candidates AS (
  SELECT id
  FROM faq_embeddings
  ORDER BY embedding_bq <~> query_bq
  LIMIT 200
)
-- Step 2: float32 で正確な距離を再計算
SELECT e.id, e.content, e.embedding <=> query_float32 AS dist
FROM faq_embeddings e
JOIN bq_candidates bq ON e.id = bq.id
ORDER BY dist
LIMIT 10;
```

---

## 3. Scalar Quantization (SQ) / halfvec

### halfvec (float16) — 推奨

| 項目 | 値 |
|---|---|
| 圧縮率 | **2倍**（float32 → float16） |
| サイズ | 1536次元 → 3,072 bytes/行 |
| リコール精度 | 95% → **93-95%**（BQ より高精度） |
| pgvector対応 | 0.7.0+ (`halfvec` 型) |

```sql
-- halfvec カラム追加
ALTER TABLE faq_embeddings ADD COLUMN embedding_hv halfvec(1536);

-- 既存データ変換
UPDATE faq_embeddings SET embedding_hv = embedding::halfvec;

-- HNSW インデックス
CREATE INDEX ON faq_embeddings USING hnsw (embedding_hv halfvec_l2_ops)
  WITH (m = 16, ef_construction = 64);
```

### int8 Scalar Quantization（pgvector 0.8+）

```sql
-- quantize_int8() 関数（pgvector 0.8+ 予定）
ALTER TABLE faq_embeddings ADD COLUMN embedding_i8 int8vector(1536);
```

| 項目 | 値 |
|---|---|
| 圧縮率 | **4倍**（float32 → int8） |
| サイズ | 1536次元 → 1,536 bytes/行 |
| リコール精度 | 95% → 93-94% |

---

## 4. 各手法の比較

| 手法 | 圧縮率 | リコール精度 | 実装難易度 | 備考 |
|---|---|---|---|---|
| float32 (現状) | 1x | 95% | — | 現在使用中 |
| halfvec (float16) | 2x | 93-95% | ★☆☆ | 最優先候補 |
| int8 SQ | 4x | 93-94% | ★★☆ | pgvector 0.8+待ち |
| Binary Quantization | 32x | 85-90% | ★★★ | 2段階検索が必要 |

---

## 5. R2C への推奨

### 判断基準

| 指標 | 対応レベル |
|---|---|
| `faq_embeddings` 行数 < 10,000 | 対応不要（現状） |
| 行数 10,000〜50,000 | **halfvec (float16)** に移行 |
| 行数 50,000〜200,000 | int8 SQ + halfvec 2段階 |
| 行数 > 200,000 | BQ + float32 再ランク 2段階 |
| テーブルサイズ > 100MB | halfvec 移行を検討開始 |

### 推奨順

1. **halfvec** — 最小リスク（2倍圧縮、精度ほぼ維持）
2. **int8 Scalar Quantization** — pgvector 0.8+ リリース後に評価
3. **Binary Quantization** — 大規模スケール（行数 10万+）で検討

### マイグレーション概要

```sql
-- Step 1: halfvec カラム追加（ダウンタイムなし）
ALTER TABLE faq_embeddings ADD COLUMN embedding_hv halfvec(1536);

-- Step 2: バックグラウンドで変換（バッチ処理）
UPDATE faq_embeddings
SET embedding_hv = embedding::halfvec
WHERE embedding_hv IS NULL;

-- Step 3: HNSW インデックス作成
CREATE INDEX CONCURRENTLY ON faq_embeddings
  USING hnsw (embedding_hv halfvec_l2_ops);

-- Step 4: 動作確認後、旧 float32 カラムを DROP
ALTER TABLE faq_embeddings DROP COLUMN embedding;
ALTER TABLE faq_embeddings RENAME COLUMN embedding_hv TO embedding;
```

---

## 6. 結論

**現在のデータ量（テナント1〜3社）では Quantization は不要。**

- 優先対応: テナント10社+でデータ量モニタリング開始
- 移行判断指標: `faq_embeddings` 行数 > 10,000 または テーブルサイズ > 100MB
- 最初の移行先: halfvec（float16）— 実装コスト最小で2倍圧縮

### モニタリングクエリ

```sql
-- テーブルサイズ確認
SELECT
  pg_size_pretty(pg_total_relation_size('faq_embeddings')) AS total_size,
  count(*) AS row_count
FROM faq_embeddings;
```

---

*次回レビュー: テナント10社到達時または 2027 Q1*
