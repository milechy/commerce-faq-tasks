

# Logging Schema（Phase12）

## 🎯 目的
AaaS の実行経路・Planner利用状況・RAG品質を  
完全に可視化するためのログ定義。

---

# 1. dialog.run.start
```
{
  tenantId,
  locale,
  preview,
  conversationId
}
```

---

# 2. dialog.rag.start / dialog.rag.finished
```
dialog.rag.finished:
  documents: number
  searchMs: number
  rerankMs: number
  rerankEngine: "heuristic"
  totalMs
```

---

# 3. dialog.planner.rule-based / dialog.planner.llm
```
{
  intentHint,
  route,
  reasons: ["rule-based:shipping"]
}
```

```
dialog.planner.llm:
  llm: "groq/compound-mini"
  latencyMs
  userMessagePreview
```

---

# 4. dialog.clarify.emit
```
{
  questions: [...]
}
```

---

# 5. dialog.answer.finished
```
{
  latencyMs
}
```

---

# 6. metaフィールド
- route
- graphVersion
- ragStats
- plannerReasons
- salesMeta（upsellTriggered / ctaTriggered）
- requiresSafeMode（未使用）

---

# 7. Webhook連携（n8n）
- agent.dialog.completed
- agent.dialog.clarify_needed
- agent.dialog.error
- slow_request
