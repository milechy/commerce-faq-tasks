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
