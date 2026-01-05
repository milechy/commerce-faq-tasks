# Phase22: Failure-Safe Conversational Control & Operational Readiness

## Goal（目的）

Phase21 で確定した会話型セールスフローおよび外部アヴァター（Lemon Slice）を対象に、
**失敗・停止・非利用を前提とした安全な制御状態を確立する**。

本フェーズの目的は、
パフォーマンス向上や KPI 達成ではなく、

- 壊れない
- 嘘をつかない
- いつでも止められる
- 後から原因を追跡できる

状態を実装・運用の両面で成立させることにある。

---

## Scope（スコープ）

### In Scope（やること）

#### 会話型セールスフロー

- マルチターン制御の厳格化
  （clarify → answer → confirm → terminal）
- 冗長質問・ループの防止
- 明確な終了条件の定義
  （完了 / 中断 / エスカレーション）

#### 外部アヴァター（Lemon Slice）

- アヴァターを **presentation layer** として扱う設計
- sales flow を **唯一の真実源（Single Source of Truth）**とする
- feature flag による即時有効化・無効化
- 障害・遅延・未接続時の即時フォールバック

#### 運用・可観測性

- flow と avatar のログ分離
- 状態遷移・失敗理由・停止理由を追跡可能にする
- 停止条件（Kill Criteria）の実装と運用可能化

---

### Out of Scope（やらないこと）

以下は **Phase22 では扱わない**。

- KPI 達成・最適化（売上、CVR、回答率など）
- レイテンシ最適化・p95 改善
- SLA の定義・保証
- 商用運用レベルの runbook 完成
- アヴァター品質改善（表情・音声・没入感）
- 自社アヴァター実装検討

※ 上記は **Phase23 以降**で扱う。

---

## Key Deliverables（成果物）

- セールス会話ステートマシン（遷移・終了条件を含む）
- 外部アヴァター制御設計（backend-only / flag / fallback）
- ログイベント定義（flow / avatar 分離）
- マルチターン統合テスト（正常系・失敗系・無効化）

---

## Design Principles（設計原則）

### 1. Single Source of Truth

- セールスフローが唯一の状態管理主体
- アヴァターは状態を保持しない

### 2. Fail Closed / Degrade Gracefully

- アヴァターは「使えない前提」で設計
- 失敗時は必ずテキスト UI にフォールバック
- UI は成功時のみ「利用中」を表示（Phase20 原則）

### 3. Kill Switch First

- いつでも止められることを最優先
- 停止してもコアフローが壊れない

---

## External Avatar Control（Phase22）

### 利用許可範囲（Phase21 継続）

- デモ・ショーケース
- PoC / R&D
- セールス説明用途
- 管理者・内部検証 UI

### 利用禁止範囲（Phase21 継続）

- PII を含む導線（注文・決済・配送・請求）
- SLA を期待される CS / FAQ 一次対応
- 常設・標準機能と誤認させる UI

### 技術的必須条件

- API Key は backend のみ
- feature flag 経由でのみ有効化
- readiness 受信後のみ接続済み表示
- 障害時の即時フォールバック
- ログは `meta.avatar.*` に分離

---

## Kill Criteria（停止条件）

以下のいずれかに該当した場合、
**外部アヴァター機能は即時無効化可能であること**。

### 技術的

- アヴァター接続失敗率の急増
- 応答遅延の継続的悪化
- 会話ループの多発

### セキュリティ / 法務

- PII 混入の疑い
- 規約・プライバシー上の問題顕在化

### コスト

- 想定コスト上限への接近・超過

※ 閾値は config / flag として外部化する。

---

## Observability（ログ・可観測性）

### ログ区分

- `meta.flow.*`：セールスフロー状態
- `meta.avatar.*`：アヴァター状態・失敗・フォールバック

### 最低限のイベント

- `flow.enter_state`
- `flow.exit_state`
- `flow.terminal_reached`
- `flow.loop_detected`
- `avatar.requested`
- `avatar.ready`
- `avatar.failed`
- `avatar.fallback_to_text`
- `avatar.disabled_by_flag`

---

## Exit Criteria（完了条件）

Phase22 は、以下をすべて満たした時点で完了とする。

- マルチターンフローがループせず終端に到達する
- アヴァターの有無・成否に関わらず会話が完走する
- 障害時に UI が嘘をつかない
- 停止条件を実運用で発動できる
- ログから flow / avatar の状態が追跡できる

---

## Phase22 の位置づけ

Phase22 は **最適化フェーズではない**。
本フェーズで行うのは「制御可能性の確立」であり、

- KPI チューニング
- レイテンシ改善
- 商用保証

は Phase23 以降に委ねる。

---

## Record（記録）

本ドキュメントは Phase22 の正式な設計・運用記録である。
Phase23 以降の変更は、本フェーズの完了条件を満たした後に行う。

---
