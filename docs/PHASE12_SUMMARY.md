

# Phase12 Summary — Planner軽量化 / Fast-path統合 / 計測基盤整備

## 🎯 フェーズ目的
Phase12 では以下を達成し、AaaS の高速・安定運用に向けた基盤を構築した。

- Rule-based Planner の確立（shipping / returns / product-info）
- clarify → answer 2ターン設計の完成
- Fast-path（Planner LLMを使わない回答ルート）の導入
- general intent の simple/complex 分離
- Planner LLM 呼び出し頻度の大幅削減
- 全ログスキーマの整理・p95 計測連携
- crewgraph / langgraph の統合動作確認

---

## ✅ 達成事項

### 1. Rule-based Planner の完成
意図ごとに missing 判定 → Clarify 分岐 → fallback の流れを固定化。

対応済み intent:
- **shipping**（product, region）
- **returns**（orderId, item, reason）
- **product-info**（product, aspect）

完全に LLM不要の Clarify を実現。

---

### 2. clarify → answer の 2ターン設計
- 1ターン目：Clarify（missingがある場合）
- 2ターン目：  
  - missing解決 → Fast-path answer  
  - 未解決 → fallbackで LLM Planner

**2ターン目で再Clarifyしないことを保証。**

---

### 3. Fast-path の導入（shouldUseFastAnswer）
simple FAQ は Planner LLM を呼ばずに RAG→Answer のみで返す。

判定要素：
- general intent のうち “simple FAQ”
- 明確な意図を持つ質問（例：支払い方法、営業時間など）
- RAGヒットが安定している質問

---

### 4. general intent の simple/complex 切り分け
**simple → fast-path**  
**complex → LLM Planner（20bモデル）**

complex の特徴:
- 比較（比較して / どれが良い）
- コツ・最適化（効率 / 一番お得）
- 判断を求める（どっちが良い）

---

### 5. Planner LLM 呼び出し頻度の削減
混在トラフィックの実測では：

- fast-path: **~60–70%**
- rule-based: **~20–30%**
- planner LLM: **~5–10%**

Planner の 20b呼び出しが激減し、p95 が大幅改善。

---

### 6. ログ・テレメトリの拡張
追加ログ：
- dialog.planner.rule-based
- dialog.planner.llm
- dialog.clarify.emit
- dialog.rag.start / finished（ragStats）
- salesMeta（upsellTriggered / ctaTriggered）
- plannerReasons
- graphVersion

SCRIPTS/analyze-agent-logs で  
p50 / p95 / max / LLM Planner呼び出し一覧  
が取れるようになった。

---

### 7. crewgraph / langgraph の統合動作
- HTTP API → crewgraph  
- 内部テスト → langgraph  
どちらでも同じ Planner / RAG / Answer パイプラインが動作。

---

## 📌 Phase12 で決まった重要ルール

1. **Clarify は 1 回のみ**
2. **simple general FAQ は LLM Planner を呼ばない**
3. **missing が解消されたら rule-based fallback で LLM Plannerは使わない**
4. **plannerReasons を必ずログに残す**
5. **ruleBasedPlanner は “null” を返す場合のみ LLM Plannerへ渡す**
6. **速度劣化時（p95 > 1500ms）は slow_request webhook で通知**

---

## 🎉 結論：Phase12 は完全に完了
AaaS を英会話教材向けに拡張するための **高速・安定・可観測性のすべてを満たす基盤** が整った。

Phase13 以降では：
- Notion連携
- 英会話SalesFlowの導入
- テナント分離
- UI統合
を進めて、最終的にテストサイト公開まで進む。