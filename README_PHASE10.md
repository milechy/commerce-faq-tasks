# Phase10 — /agent.dialog HTTP/E2E 安定化

> ⚠️ **PR-10 訂正 (2026-08-23)**: 本ドキュメントが指す `/agent.dialog`
> エンドポイントおよび後続の LangGraph/CrewGraph 統合一式は、学習ループ
> 監査(R10/D5)で `/api/chat`（live経路）から一度も呼ばれていない死コードと
> 判明し、PR-10 で削除済み。本ドキュメントは当時の実装記録として歴史的に
> 残すが、現在の本番構成には該当しない。

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
