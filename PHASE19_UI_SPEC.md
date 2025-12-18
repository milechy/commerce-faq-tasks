# Phase19 UI Specification

## Purpose

Phase19 UI は「ローンチ用 UI の最小形」であり、目的は **成果の可視化と検証** です。
見た目ではなく、**システムの意思決定（検索 → 再ランク → 生成 → 販売文脈）を人が判断できる** ことを最優先にします。

## Core Principle

> If you cannot see what the system decided, the UI is wrong.

## Scope (Phase19 で“必ず”できること)

1. **1 ターン検索（Query → Answer）**
2. **Sales 回答の妥当性を人が判断できる**
3. **CE の状態と rerank の挙動が UI で即わかる**
4. **フィードバックを最短で残せる（人力で OK）**

## UI Structure

### 1. Query Input

- 入力欄（1 つ）
- 送信ボタン（1 つ）
- 例文ボタン（任意）
- **履歴・スレッドは不要（Phase19 ではやらない）**

### 2. Answer Panel

- 生成された answer をそのまま表示
- 余計な装飾や自動要約はしない
- 「営業っぽい言い回し」かはここで判断する

### 3. Evidence / Context Panel（任意だが推奨）

- rerank 後の上位 FAQ（上位 N 件）を表示
- 各 item の `id / source / score` を表示
- 「なぜこの答えになったか」の説明責任を担保する

### 4. Metadata Panel（必須）

必ず可視化する項目：

- `meta.ragStats.rerankEngine`
- `ce_ms`
- `meta.flags`（例：`ce:active` / `ce:skipped`）
- `meta.tenant_id`（または同等）
- `meta.duration_ms`（または同等）

**CE が不活性/失敗/フォールバックの場合は一目でわかる表示**にすること。

### 5. Manual Evaluation（必須）

Yes/No で即答できるチェックに限定する：

- この回答はそのまま顧客に出せる？
- 長すぎない？
- 足りない？
- 言い切りすぎていない？
- 関係ない FAQ を拾っていない？
- CE は有効だった？（metadata と一致している？）

### 6. Feedback Capture（Phase19 最優先）

- UI 内で「ひとことフィードバック」を残せる導線
- 実装は暫定で良い（例：コピー → 貼り付け運用でもよい）
- ただし **“残すことができる”状態** を Phase19 完了条件に含める

## Explicit Non-Goals (Phase19 ではやらない)

- 会員/ログイン
- 分析ダッシュボード
- マルチターン履歴 UI
- AB テスト UI
- 自動改善
- Phase20 以降の高度 UI

## Failure Conditions

以下のいずれかを満たすと UI は失敗：

- metadata が見えない
- CE のフォールバックが見えない（＝「動いたように見える」）
- answer が provenance（根拠）なしで表示される
- フィードバックが残せない

## File Edit Rule (Must)

**UI に変更を加える前に、変更対象ファイルを宣言すること。**
宣言なしの編集は禁止（サイレントドリフト防止）。
