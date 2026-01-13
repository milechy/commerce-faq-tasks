# Phase20：ポスト診断コンソリデーション（Canonical）

Phase20 は **ポスト診断（post-diagnostic）コンソリデーションフェーズ**である。

Phase19 は意図的に以下を残した：

- 実システム挙動の露出
- RAG / rerank / CE の可観測性の正規化
- あえて未完成のまま止める判断

Phase20 はそれらの**観測結果を事実（factual input）として扱い**、次の問いにだけ答える。

> 「このフェーズ終了時点で、このシステムについて“実際に正しいこと”は何か？」

---

## 明示的な非目標（Non-goals）

Phase20 は以下を**行わない**。

- 新たなエンドユーザー機能の追加
- fallback や skipped 挙動の隠蔽
- 明白な矛盾解消を超える性能最適化
- Phase19 の結果を“きれいに見せる”ための再解釈

未決事項は、**未決であると明示する**。

---

## Canonicalization モデル（API / Metadata）

### Canonical（Phase20 時点で正）

- `meta.ragStats`

  - RAG の挙動・実測値に関する**唯一の正**。

- `meta.ragStats.rerankEngine`

  - 実際に採用された rerank 経路の **canonical 表現**。

- `meta.ragStats.ce_ms`

  - CE 実行時の実測時間（ms）。

- CE fallback / skipped の存在

  - 成功扱いせず、**事実として露出**する。

- `meta.route` / `meta.duration_ms`

  - 比較・トラブルシュートのための canonical 情報。

---

### Transitional（互換・観測用ミラー）

以下は存在を認めるが、**正の定義は持たない**。

- `meta.engine`
- `meta.ce_ms`
- `meta.flags.*`
- `/agent.search` における steps 由来 meta の抽出・正規化
- snake / camel 両対応の ragStats 受理

**ルール**

- 正は常に `meta.ragStats`。
- 不一致（drift）は Phase20 バグとする。

---

### Deprecated（破壊的変更回避のためのみ存続）

- top-level `engine`
- top-level `ce_ms`
- top-level `ragStats`（互換目的）

これらは**後方互換のためにのみ残存**し、
`meta.ragStats` と一致しなければならない。

---

## `/agent.search` と `/search.v1` の境界（明示）

Phase20 は **統合を強制しない**。代わりに、境界を説明可能にする。

- `/search.v1`

  - 単発の hybrid search + rerank API
  - legacy フィールドを返しつつ、canonical な `meta.ragStats` を提供

- `/agent.search`

  - planner / tools / steps を含むエージェント実行 API
  - steps 由来の観測情報を meta として露出（Phase19 由来の暫定）

両者が異なる挙動を示す場合、
**その差は docs / UI によって説明されなければならない**。

---

## UI ルール（Phase20）

UI は **診断ファースト**であるが、次を厳守する。

- Raw response をそのまま表示する
- metadata を verbatim で表示する
- `/search.v1` と `/agent.search` の差を並べて比較できる
- top-level と `meta.*` を恣意的に統合・選択しない

UI は以下を**行ってはならない**。

- エンジンや結果の優劣判断
- fallback / skipped の意味付け
- 正解・不正解のラベリング

---

## Phase19 で未実装だった UI 要素（事実として固定）

以下は **Phase19 時点で存在しない**。

- Partner Verification UI（Yes / No）
- 人間による一言フィードバック入力
- 検証結果の保存
- Evidence（根拠 FAQ）の構造化表示

これらは欠陥ではなく、**未達として歴史的に固定**される。

---

## 外部（他社）アヴァター API に関する扱い（重要）

- UI における **他社アヴァター API 利用可否の判断・サポート**は
  **Phase20 のスコープ外**である。
- Phase20 では以下のみを宣言する：

  - 現時点で **未検討・未対応**
  - 可否判断・統合・サポートは **Phase21 以降に明示的に検討される事項**

Phase20 で黙って対応済みにすることは**禁止**。

---

## テストルール（Phase20）

テストは **理想ではなく観測事実を固定**する。

- snapshot テストは可
- 既知の歪み・不整合はコメント付きで明示
- 将来の cleanup を前提としたテストは禁止

---

## Phase21+ への引き渡し（明示的に Deferred）

Phase20 は以下を**解決しない**。
Phase21 は、**この未決リストを前提に進む**。

- `/agent.search` と `/search.v1` の将来的関係
- transitional / deprecated フィールドの削除方針
- `meta.flags` の存廃
- `meta.ragStats` の schema 進化・保証範囲
- drift 検知とエスカレーションの実装場所
- Partner Verification の設計
- 外部（他社）アヴァター API 連携・可否サポート

---

## Phase20 の最終宣言

Phase20 は
**真実を整列させただけで、何も完成させていない。**

そしてそれこそが、
**Phase21 を正しく開始するための必要十分条件である。**

---

## Deprecated：旧 Phase20 草案（履歴保持）

本リポジトリには、Phase20 開始時点（2025-12-18）に
「Sales Answer Quality & Policy Intelligence」を主題とする
別内容の Phase20 草案が存在していた。

これは現在の Phase20 定義と矛盾するため、
**履歴保持目的でのみ残し、効力は持たない。**

---
