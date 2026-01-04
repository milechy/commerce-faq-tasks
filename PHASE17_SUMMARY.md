# Phase17 Summary – RAG パフォーマンス計測・設計フェーズ

## 目的

Phase17 では、/dialog/turn 上で動作する RAG パイプラインのうち、

- 検索レイヤ（`/search.v1`）の実測パフォーマンスを可視化すること
- p95 ≤ 1.5s を目標としたときの「RAG 部のレイテンシ予算」を設計レベルで整理すること
- 後続フェーズ（Cross-Encoder ONNX 導入, pgvector 再有効化）時に、
  追加実装なしで p50/p95 をトラッキングできるメトリクスの土台を作ること

をゴールとした。

## 実装変更（Phase17 時点）

### 1. `/search.v1` エンドポイントの計測拡張

対象: `src/index.ts`

- `/search.v1` ハンドラに RAG メトリクスを追加した。

  - 検索全体の計測（ハイブリッド検索部分）:

    ```ts
    const tSearch0 = Date.now();
    const results = await hybridSearch(q);
    const tSearch1 = Date.now();

    const search_ms = Math.max(0, tSearch1 - tSearch0);
    ```

  - rerank（Cross-Encoder 部分）のレイテンシは `re.ce_ms` から取得:

    ```ts
    const rerank_ms =
      typeof re?.ce_ms === "number" ? (re.ce_ms as number) : undefined;
    const total_ms =
      typeof rerank_ms === "number" ? search_ms + rerank_ms : search_ms;
    ```

  - レスポンスの `meta` に `ragStats` と `hybrid_note` を追加:

    ```jsonc
    {
      "items": [...],
      "meta": {
        "route": "hybrid:es50+pg50",
        "tuning_version": "v1",
        "flags": ["v1", "validated", "ce:skipped"],
        "ragStats": {
          "search_ms": 611,
          "rerank_ms": 1,
          "total_ms": 612
        },
        "hybrid_note": "pg_fts:disabled_phase7_use_pgvector | search_ms=611 es_ms=610 es_hits=3 pg_hits=0"
      },
      "ce_ms": 1
    }
    ```

  - これにより、1 リクエスト単位で以下が観測可能になった。
    - `search_ms`: hybridSearch 全体（Embedding + ES + pgvector + マージ）
    - `rerank_ms`: CE の処理時間（Phase17 では dummy）
    - `total_ms`: RAG 全体（search_ms + rerank_ms）
    - `hybrid_note`: hybrid 内部の追加情報（es_ms, es_hits, pg_hits など）

### 2. `hybridSearch` の ES 内訳計測

対象: `src/search/hybrid.ts`

- ES 部分の所要時間を `es_ms` として計測:

  ```ts
  const tEs0 = Date.now();
  const esRes: any = await es.search(/* ... */);
  const tEs1 = Date.now();
  esElapsedMs = tEs1 - tEs0;
  ```

- `metricsNote` を拡張し、ES 内訳を含めるようにした。

  ```ts
  const metricsNote = [
    `search_ms=${elapsed}`,
    `es_ms=${esElapsedMs ?? "na"}`,
    `es_hits=${esHits.length}`,
    `pg_hits=${pgHits.length}`,
  ].join(" ");
  ```

- `hybridSearch` の戻り値に `note` として格納し、`/search.v1` 側で `meta.hybrid_note` として返却。
- これにより、例として以下のような内訳が確認できる:

  ```text
  "hybrid_note": "pg_fts:disabled_phase7_use_pgvector | search_ms=611 es_ms=610 es_hits=3 pg_hits=0"
  ```

  → 「このクエリに対しては、ほぼ ES 単独 (~610ms) で動いており、pgvector は使われていない」ことが分かる。

### 3. ベンチマークスクリプトの `/search.v1` 対応

対象: `SCRIPTS/bench-agent-search.ts`

- エンドポイントを `/agent.search` から `/search.v1` に変更:

  ```ts
  const ENDPOINT = process.env.ENDPOINT ?? "http://localhost:3100/search.v1";
  ```

- リクエストボディを `/search.v1` のスキーマに合わせて簡略化:

  ```ts
  const body = {
    q: queries[i % queries.length],
    topK: 8,
  };
  ```

- レスポンスから以下のメトリクスを抽出するようにした:

  - `json.meta.ragStats.search_ms` → `search_ms`
  - `json.meta.ragStats.total_ms` → `rag_total_ms`
  - `json.ce_ms` / `meta.ragStats.rerank_ms` → `rerank_ms`

- `meta.ragStats` が無い場合のフォールバックとして、従来どおり `debug.search.ms` / `debug.rerank.ce_ms` も見るロジックを残した。

### 4. TypeScript 型エラーの解消（Phase17 のビルド前提整備）

対象: `src/agent/dialog/dialogAgent.ts` / `src/agent/orchestrator/sales/runSalesFlowWithLogging.ts` / `src/index.ts`

- SalesFlow / Dialog / Logging 間の型を揃え、Phase17 時点の構成で `tsc` が通るように調整。
  - SalesDetectionContext の `history` に `DialogMessage[]` ではなく `"user" | "assistant"` のみを渡すよう変換。
  - `personaTags: string[]` に対して `undefined` が渡らないよう、`personaTags ?? []` に統一。
  - `/dialog/turn` の `language` を `z.enum(["ja", "en", "auto"]).optional()` に変更し、`DialogTurnInput` と整合。

## 計測結果とインサイト

### 1. `/search.v1`（RAG 検索レイヤ）の実測値

`SCRIPTS/bench-agent-search.ts` による 100 リクエストの計測:

- HTTP レイテンシ:
  - `latency p50/p95 ≒ 628 / 654 ms`
- RAG 内訳:
  - `search_ms p50/p95 ≒ 625 / 651 ms`
  - `rerank_ms p50/p95 ≒ 1 / 1 ms`（dummy CE）
  - `rag_total_ms p50/p95 ≒ 626 / 652 ms`

→ RAG 全体の p95 ≒ 650ms であり、HTTP オーバーヘッドを含めても `/search.v1` は **おおむね 0.6〜0.7 秒レンジ** に収まっている。

### 2. hybridSearch 内訳（ES vs その他）

`meta.hybrid_note` のサンプル:

```text
"hybrid_note": "pg_fts:disabled_phase7_use_pgvector | search_ms=611 es_ms=610 es_hits=3 pg_hits=0"
```

- `search_ms` (hybrid 内) と `es_ms` の差分が 1ms であり、ほぼすべての時間が ES クエリに使われている。
- `pg_hits=0`, `pg_fts:disabled_phase7_use_pgvector` から、Phase17 時点では pgvector 経路は実質無効。

→ 「Phase17 スナップショットでは、 `/search.v1` のレイテンシは **ほぼ ES 単独検索のレイテンシ ≒ 600ms** に等しい」と言える。

### 3. Cross-Encoder (CE) の状態

- `/ce/status` のレスポンス:

  ```json
  {
    "onnxLoaded": false,
    "onnxError": null,
    "engine": "dummy"
  }
  ```

- `/search.v1` の `meta.flags` には `"ce:skipped"` が付与されており、`ce_ms` は 1ms 前後。

→ Phase17 時点では Cross-Encoder は **dummy エンジンとしてのスタブ実装のみ** であり、
ONNX モデルによる本格的な rerank はまだ導入されていない。

### 4. RAG p95 と E2E レイテンシ予算

Phase17 での暫定的なレイテンシ予算の整理:

- RAG (`/search.v1`)：
  - 実測: `rag_total_ms p95 ≒ 650ms`
  - 目標: CE 導入後も **p95 ≤ 700〜800ms** に収めたい
- Answer LLM（自然文回答生成）:
  - モデル・プロンプトに依存するが、FAQ 用設定で **p95 900〜1000ms 程度** を想定
- その他（Planner / SalesFlow / Logging 等）:
  - **100〜200ms 以内** が望ましい

この前提のもと、`/dialog/turn` の E2E p95 を 1.5s 付近に抑えるためには:

- CE 導入による `rerank_ms` の増分を **p95 +100〜150ms** 程度に抑えること
- あるいは ES 側・Answer LLM 側でそれぞれ 100ms 前後の削減余地を見込むこと

が重要になる。

## 今後の課題・次フェーズへの引き継ぎ

1. **Cross-Encoder (ONNX) 導入**

   - `engine: "onnx"` モードの実装と、モデルファイル管理（パス / バージョン管理）。
   - `rerank_ms p95` のターゲット値（例: ≤100ms）を満たすような topK / バッチサイズ設計。
   - CE 有効化時には、Phase17 で整備した `rerank_ms` / `total_ms` を使って RAG p95 の差分を比較する。

2. **pgvector の再有効化と役割分担設計**

   - ES / pgvector のトップ K 分配（例: ES 32 件 + pgvector 32 件 → マージ 40 件 → CE）。
   - `hybrid_note` を拡張し、`pg_ms` や `pg_hits` もメトリクスとして扱えるようにする。
   - 「ES-only」「pgvector-only」などのルート設計と `meta.route` の更新。

3. **/dialog/turn 側のメトリクス整備**

   - `/dialog/turn` にも `ragStats` 相当の情報・E2E レイテンシを載せ、  
     「1 ターンあたりの RAG + Answer + SalesFlow」の内訳を把握できるようにする。

4. **ドキュメント更新**
   - `docs/search-pipeline.md` に `/search.v1` のパイプライン仕様と `ragStats` のスキーマを追記。
   - `docs/P95_METRICS.md` に `/search.v1` ベースラインの測定結果と、ターゲット値を記載。
   - `docs/LOGGING_SCHEMA.md` に `meta.ragStats` / `meta.hybrid_note` を踏まえたログ設計を整理。
