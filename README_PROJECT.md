# Commerce-FAQ MVP — 開発プロジェクト README

本プロジェクトは **Issues + Labels + PRの自動クローズ** だけで管理します（GitHub Projects不要）。
詳細運用は `AGENTS.md` を参照。

## 目的（v2025-10-R3 準拠）
- p95 ≤ 1.5s を満たす応答品質/レイテンシの両立
- RAGハイブリッド（pgvector + Elasticsearch + Cross-encoder再ランク）の安定運用
- モデルルーティング（20B→120B昇格・段階フォールバック）
- 多言語（ja/en）先行対応
- 従量課金（実コスト×係数）自動化 & メール連携
- 監視（Datadog/Otel）とRunbook運用

## 進め方（最小）
1. **Issue起票**（テンプレ：`3_TASKS.md` 参照 or `5_SCRIPTS/new_task_template.sh`）
2. **ブランチ作成**：`<type>/<slug>-<#>` 例: `feat/rag-hybrid-perf-4`
3. **PR本文**に `Closes #<番号>` を入れる（マージで自動Close）
4. ステータスは **ラベル付替え**：`status:todo → in-progress → review → qa → done`

## ラベル
- status: `todo / in-progress / review / qa / done`
- prio:   `high / medium / low`
- type:   `feat / bug / chore / ops`
- phase:  `db / api / ui / billing / monitoring / ci`

> ラベルの作成済み確認：`gh label list -R milechy/commerce-faq-tasks`