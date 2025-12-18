# p95 Metrics — Phase12 計測ルール

## 🎯 目的

高速性（1.5s 以下）を安定して達成するための  
計測方法・閾値を標準化する。

---

# 1. 計測対象

### RAG（dialog.rag.finished）

- searchMs
- rerankMs
- totalMs

### Planner（dialog.planner.llm）

- latencyMs

### Answer（dialog.answer.finished）

- latencyMs

### End-to-end（今後）

- user → answer の全体時間

---

# 2. 理想値（Phase13 以降の目標）

| Layer       | p95          | 備考                      |
| ----------- | ------------ | ------------------------- |
| RAG         | 600〜800ms   | topK 調整で改善           |
| Answer      | 900〜1200ms  | prompt 短縮で改善         |
| Planner LLM | 2500〜3500ms | 呼び出しは 5〜10%に抑える |
| End-to-end  | **≤ 1500ms** | Fast-path 中心            |

## 2.1 Phase17 現状値（/search.v1 ベンチマーク）

Phase17 では、RAG レイヤの実測値として `/search.v1` に対して 100 リクエストのベンチマークを実施した。

- 計測対象: `SCRIPTS/bench-agent-search.ts` による `/search.v1` への連続リクエスト（N=100）
- 計測結果（代表値）:
  - RAG 全体（/search.v1 HTTP 往復込み）
    - `latency p50/p95 ≒ 628 / 654 ms`
  - RAG 内部（search + rerank）
    - `search_ms p50/p95 ≒ 625 / 651 ms`
    - `rerank_ms p50/p95 ≒ 1 / 1 ms`（現状は dummy Cross-Encoder）
    - `rag_total_ms p50/p95 ≒ 626 / 652 ms`

補足:

- `/search.v1` の `meta.hybrid_note` から、`search_ms` と `es_ms` はほぼ一致しており、多くのクエリで RAG の大部分が Elasticsearch 検索のレイテンシとなっている。
- Phase17 時点では pgvector は無効化されており、Cross-Encoder は `engine: "dummy"` としてスタブ実装になっている（`ce_ms ≒ 1 ms`）。
- 将来 ONNX Cross-Encoder / pgvector を有効化する際は、上記のベースラインからの増分（特に `rerank_ms p95`）をモニタリングする。

---

# 3. 使用ツール

```
node dist/SCRIPTS/analyze-agent-logs.js logs/app.log
```

出力：

- count
- min / p50 / p95 / max
- LLM Planner 呼び出し一覧

---

# 4. slow_request 基準（n8n 通知）

- totalMs > 2000 → Slack #alerts
- Planner latency > 3000
- RAG totalMs > 1500
- Answer latency > 1500

---

# 5. 改善サイクル

1. p95 悪化
2. n8n → Slack 通知
3. Clarify Log / FAQ 補強
4. topK 調整
5. prompt 短縮
