

# Fast-path Logic（Phase12）

## 🎯 目的
LLM Planner を呼ばずに回答できるケースを自動判定し、  
高速（1.0〜1.5s）で安定したレスポンスを返す。

---

# 1. Fast-path が有効になる条件（shouldUseFastAnswer）

以下をすべて満たすと Fast-path を適用：

### ✔ RAG が十分にヒットしている  
- top documents のスコアが安定
- 再検索不要

### ✔ 質問が “simple general FAQ”
例：
- 営業時間を教えてください
- 支払い方法は？
- キャンセルできますか？

### ✔ 複雑な判断を含まない
含む例（→ LLM Planner）：
- 「どっちが良い？」
- 「比較すると？」
- 「一番効率よく」
- 「おすすめ教えて」

---

# 2. Fast-path の挙動

### 1ターン目
- clarify不要 → そのまま回答  
- clarify必要 → Clarifyを返す

### 2ターン目
- missing解消 → Fast-path answer  
- missing未解消 → fallback（LLM Planner）

---

# 3. general intent の simple/complex 判定

### simple（Fast-pathへ）
- 事実ベース
- よくある質問
- ユーザーの目的が明確

### complex（LLM Plannerへ）
- 比較
- コツ・最適化
- 判断依頼
- ストラテジックな質問

---

# 4. 実測結果（Phase12）
混在トラフィックで：

- fast-path: **58〜70%**
- rule-based: **20〜30%**
- planner LLM: **5〜10%**

fast-path の導入により、p95 が大幅に安定。

---

# 5. 今後の拡張（Phase13〜）
- 英会話の “simple質問” を定義  
- Products / LP Points を参照した高速回答  
- persona-based fast-path  