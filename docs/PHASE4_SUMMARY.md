

# Phase4 Summary — Agent Orchestration & Performance Optimization

本ドキュメントは Phase4 における機能追加・アーキテクチャ更新・性能改善の全内容をまとめたものです。  
`ARCHITECTURE.md` / `AGENTS.md` に追記された内容の詳細版として、開発・レビュー・運用の基礎資料となります。

---

# 1. Phase4 全体概要

Phase4 では、Commerce FAQ SaaS における **対話制御・検索統合・安全性・性能** の4領域を大幅改良した。

主要な変更は以下：

### ● LangGraph ベースの Dialog Orchestrator 導入  
Clarify / Follow-up / Search / Answer をマルチステップで制御。

### ● Groq 20B / 120B ルーティング最適化  
安全性・複雑性に応じて動的にモデル切り替え。

### ● Fast-path（Planner スキップ）による高速化  
2ターン目以降で Planner を省略し、p50 ≒ **1.6〜1.8s** を達成。

### ● 長期履歴 summary による上下文圧縮  
120B への不必要な昇格を防止し、context budget も安定化。

### ● RAG（ES+pgvector+Cross-encoder）との完全統合  
Planner の search ステップを Phase3 RAG に紐づけ。

### ● トークン/回答スタイル最適化  
答えを短くし、maxTokens も削減（20B=256, 120B=320）。

### ● Safety モード強化  
暴力/虐待/自傷/法務/規制などは強制的に 120B & 慎重回答。

---

# 2. LangGraph Dialog Orchestrator

## 2.1 ノード一覧

| ノード | 役割 |
|-------|------|
| ContextBuilder | RAG + 履歴サマリ + intent 分析 |
| Planner | Clarify / Follow-up / Search ステップ設計 |
| SearchAgent | Phase3 RAG にクエリ実行 |
| AnswerAgent | コンテキストから最終回答生成 |
| Router | Clarify / Search / Answer の分岐 |

## 2.2 処理フロー

1. **ContextBuilder**  
   - history summary（必要時）  
   - routeContext（intent / safety / complexity）生成  

2. **Planner（20B/120B）**  
   - ステップ計画 Clarify → Search → Answer  
   - 昇格判断（安全/複雑）

3. **Decision Router**  
   - ステップに応じて SearchAgent, AnswerAgent を実行

4. **AnswerAgent（20B/120B）**  
   - 短めの回答（3〜8文）  
   - safety トーン調整  

5. **最終応答として返却**  

---

# 3. Route Planner v2（20B/120B）

## 3.1 追加された安全性要素

- `safetyTag`  
- `requiresSafeMode`（true → 強制120B）

## 3.2 理由付け（plannerReasons）

例：
- `base-rule:20b`
- `complexity:upgrade-to-120b`
- `safe-mode:upgrade-to-120b`
- `history-depth:summary-applied`

---

# 4. Fast-path（Planner スキップ）

## 4.1 目的
Clarify 翌ターン（2nd turn）の不要な Planner LLM 呼び出しを削減。

## 4.2 発動条件

- history > 0  
- safety 無し  
- intent ∈ { shipping, returns, payment, product-info }  
- user message が十分長い（len >= 15）  

## 4.3 効果

- Planner（20B）1発分を削減  
- p50 を大幅改善：  
  - before: 2.0〜2.4s  
  - after: **1.6〜1.8s**

---

# 5. 長期履歴 Summary

## 5.1 実装ポイント

- history 長が一定以上 → summary 短縮  
- summary + 直近2ターンのみを Planner/Answer に渡す  
- context_tokens を budget 1500〜1600 に制御  

## 5.2 効果

- LLM context 上限に近い長期対話での 120B 昇格率を低減  
- RAG context の質を維持

---

# 6. Search Agent（Phase3 RAG 統合）

## 6.1 構成

- Elasticsearch（BM25）
- pgvector（semantic）
- CrossEncoder（top80 → rerank → top5）

## 6.2 Planner との接続

Planner の Search ステップ：
```
{
  id: "step_search_1",
  type: "search",
  query: "...",
  topK: 8,
  filters: { ... }
}
```
→ SearchAgent → hybridSearch() を実行  
→ AnswerAgent に結果を渡す

---

# 7. p95 / パフォーマンス評価

## 7.1 計測方法

- SCRIPTS/loadTestDialogGraph.js  
- 30リクエスト  
- shipping / returns / payment / product_stock  
- Clarify（1ターン目）＋followup（2ターン目 fast-path）の混合

## 7.2 結果（2025-11-16）

| 種別 | p50 | p95 |
|------|------|------|
| Clarify（1ターン目） | 1.8〜2.7s | 3.3〜3.8s |
| Followup fast-path | **1.35〜1.8s** | 2.4〜3.6s |
| Safety 120B | 2.7〜4.0s | 4.0〜4.7s |

---

# 8. Safety モード（120B）

- 120B へ強制昇格  
- 慎重な回答・相談窓口・危険回避の表現  
- 暴力/虐待/自傷/法務/違法/規制 に反応  

---

# 9. ログ拡張（pino）

`/agent.dialog` のログに：

- `durationMs`
- `route` (20b/120b)
- `plannerReasons`
- `safetyTag`
- `requiresSafeMode`
- `orchestratorMode`
- `ragContext`（recall情報）

---

# 10. Phase4 の成熟度

- アーキテクチャ統合度：★★★★★  
- 性能（p50）：★★★☆☆ → 改善余地あり  
- 性能（p95）：★★☆☆☆ → fallback/Groq混雑依存  
- Safety：★★★★☆  
- 検索統合：★★★★☆  

---

# 11. Phase5 への接続点

- Planner 20B → 8B 代替の検討（超軽量化）
- Search Agent の外部プロセス化（非同期）
- context-budget の動的制御（LLM token 負荷分散）
- fallback local agent を高速化（モデル軽量化）

---

以上が Phase4 の完全まとめです。