

# Phase Roadmap

## Phase18 – UI / CE Integration（完了）

- Cross-Encoder (dummy / onnx) 実装
- rerank gating / fallback 安定化
- /ce/status, /ce/warmup API 整備
- ragStats 仕様確定（Phase19 互換）
- パートナー検証用 UI 提供

Status: ✅ Completed

---

## Phase22 – Failure-Safe Conversational Control（完了）

- マルチターン制御の厳格化（clarify → answer → confirm → terminal）
- ループ検出とループ防止（状態パターン、Clarify署名）
- 外部アヴァター制御（PII検出、Feature Flag、Kill Switch）
- 運用・可観測性（flow × 4、avatar × 7 イベント）
- 決定的終端保証（予算制限、ループ上限）

Status: ✅ Completed (2026-01-13)

詳細: [PHASE22.md](../PHASE22.md), [docs/PHASE22_IMPLEMENTATION.md](../docs/PHASE22_IMPLEMENTATION.md)

---

## Phase23 – KPI & SLA Definitions（完了）

- MVP KPI セット定義（会話完了率、ループ検出率、アヴァターフォールバック率、検索レイテンシ、エラー率、Kill Switch発動回数）
- SLA ゲート閾値の明文化（CI/CD vs 本番）
- 日次チェック手順の標準化（5分チェック、週次レビュー）
- インシデント対応フロー（Kill Switch First）
- ローカル計測コマンド整備（7つのKPIスクリプト）

Status: ✅ Completed (2026-01-13)

詳細: [docs/PHASE23.md](../docs/PHASE23.md)

---

## Phase24 – Dashboard & Alerting（予定）

- リアルタイムダッシュボード（Grafana / Datadog）
- 自動アラート配信（PagerDuty / Slack 統合）
- 長期トレンド分析・予測モデル
- カスタム SLA（テナント別・地域別）

Status: 🔜 Planned