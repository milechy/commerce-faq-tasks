## 🧠 概要
`/agent.dialog` の Planner 経路を高速化し、p95（95%tile）の安定化を目的として以下を実施。

- shipping / returns / product-info 向け Rule-based Planner の本実装
- general intent の simple/complex分類と Fast-path の導入
- clarify → answer の 2ターン仕様を確立
- RAG / Planner / Answer の p50/p95 計測ループ（analyze-agent-logs.ts）
- metaフィールド統合（route / graphVersion / ragStats / plannerReasons / salesMeta）

---

## ✨ 主な改善点

### ✔ Rule-based Planner
- intentHint に応じて missing フィールドを判定し、Clarify 質問を返却
- 全フィールド揃っていれば null → LLM Planner fallback

### ✔ Fast-path（simple general FAQ）
- 「支払い方法を教えてください」などの simple general を高速返答
- 「一番お得」「比較して」などの complex general のみ LLM Planner 経由

### ✔ clarify → answer の2ターン設計
- 1ターン目: Clarify  
- 2ターン目: Answer（再Clarifyしない）

### ✔ p95測定
- RAG / Planner / Answer それぞれの p50 / p95 / max を解析
- Planner LLM 呼び出しは全体の **5〜10% に減少**

---

## 📊 Phase12 の効果
- `/agent.dialog` の p95 が 1.5〜2.0s レンジで安定
- LLM Planner を必要最小限（5〜10%）に抑制
- Clarify の自然さ・情報取得精度が向上

---

## 🔜 次フェーズ（Phase13）
- Notion DB による Rule-based Planner 外部化
- 英会話教材向け intent（level_diagnosis, goal_setting）
- Fast-path のさらなる拡張
