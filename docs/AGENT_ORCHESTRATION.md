

# Agent Orchestration（Phase12）

## 🎯 目的
crewgraph / langgraph / Rule-based Planner / RAG / Answer  
の全体経路を統一仕様として明確にする。

---

# 1. フロー全体像

1. **run.start**
2. **RAG**
3. **Planner**
   - rule-based → clarify or null
   - LLM Planner（fallback）
4. **Clarify**
5. **Answer**
6. **(run.success)**

---

# 2. Graph Version
```
graphVersion: "langgraph-v1"  
```

今後：
- crewgraph-v2  
- salesgraph-v1 などに拡張

---

# 3. Planner フロー

### 1) Rule-based Planner
- intentHint に応じて missing 判定
- missingあり → Clarify
- missingなし → null（LLM Plannerへ）

### 2) LLM Planner
実行条件：
- ruleBasedPlanner が null
- simpleFAQ ではない
- complex general の場合

---

# 4. Clarify ノード
- clarifyingQuestions を meta に返す  
- 2ターン目で Clarify は行わない（Phase12で確定）

---

# 5. Answer ノード
- fallback or fast-path  
- salesMeta を付与（upsell/cta）

---

# 6. metaフィールド構造
- route: "20b"
- plannerReasons
- ragStats
- salesMeta
- graphVersion

---

# 7. 今後の拡張
- SalesPipeline（clarify → propose → recommend → close）
- Notion DB からテンプレート読込
- 英会話教材テナント統合