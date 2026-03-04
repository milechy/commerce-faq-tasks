# Phase10 — /agent.dialog HTTP/E2E 安定化

## 概要

実装リポジトリ側で `/agent.dialog` の HTTP レイヤを安定化し、  
Phase11（LangGraph/CrewGraph 統合）のための基盤を完成させた。

## 完了内容

- sessionId 発行・再利用の安定化
- multi-step planner（clarify→search→answer）
  - clarify 時 `answer=null` の統一
  - テスト期待値と実装を完全同期
- 認証
  - `x-api-key` を正式化（Phase9 の `x-agent-api-key` を廃止）
  - Basic 認証（demo/pass123）は dev only
- E2E テスト（グリーン）
  - basic dialog returns answer and steps
  - dialog reuses sessionId across turns
  - clarify flow returns answer=null when multi-step enabled

## 次フェーズへの引き継ぎ

- LangGraph / CrewGraph integration
- meta.multiStepPlan の実データ化
- グラフ状態遷移ログの拡張（clarify/search/answer）
