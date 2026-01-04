# Notion Overview — Sales AaaS Config & Tuning Console

## 🎯 目的

Notion は、このプロジェクトにおける「管理画面 / CMS / CRM」に相当し、
**Sales AaaS の設定・チューニング・運用モニタリングのすべてを担う外部コンソール** として利用する。

アプリ側（Node/TS）は、Notion を以下の用途で参照・更新する：

- 🧱 **コンテンツDB**: FAQ / Products / LP Points などの「回答の元ネタ」
- 🧠 **チューニングDB**: Sales テンプレ（Clarify/Propose/Recommend/Close）やトーン・禁止表現
- 📊 **運用DB**: Clarify Log / Billing Summary / Sales Funnel などのログ・メトリクス

最終的なゴールは、

> **「パートナーは Notion だけを編集すれば、AI セールスエージェントの性格・台本・教材ラインナップを自在に変えられる」**

状態を作ること。

---

## 🧱 Notion に存在する主な DB

Phase13 以降で想定している代表的な DB は次の通り：

1. **FAQ DB**
   - ユーザーのよくある質問と、それに対する一次回答（Q/A）を管理
   - RAG の中心になるデータソース

2. **Products DB（教材 / 商品）**
   - 英会話教材やプラン、オプションなどの商品情報
   - レベル・価格・特徴・USP・比較タグ などを持つ

3. **LP Points DB（LP/HP の訴求ポイント）**
   - ランディングページのセクション構造と、強調すべきメッセージ
   - AI が提案・CTA を出す際の「根拠」として参照

4. **Tuning Templates DB（Sales 台本 / トーン）**
   - Clarify / Propose / Recommend / Close / Objection Handling を含むテンプレ
   - CTA 文言、トーン設定（Simple/Polite/SalesSoft）、禁止表現 など
   - パートナー独自の心理学・営業ノウハウをここに注入する

5. **Clarify Log DB**
   - 実際に Clarify が発生した対話ログを保存
   - 「どこで質問が分かりづらかったか」「どんな Clarify が多いか」を可視化
   - パートナーのチューニング対象を特定するための“証拠箱”

6. **Billing Summary / Usage DB**
   - テナントごとの利用量・コスト・売上・粗利
   - n8n + Postgres の集計結果を Notion に同期し、採算管理に使う

7. **Sales Funnel / Navigation Log DB（任意）**
   - Clarify → Propose → Recommend → Close の到達状況
   - CTA クリック / LP ナビゲーション などの UI イベント

---

## 🧩 Notion と AaaS の責務分離

- **Notion が持つもの**
  - テキスト・構造化データ
  - 営業トーク / 心理学ノウハウ
  - 商品・LP・FAQ の内容
  - メトリクスのダッシュボード（Billing / Clarify / Funnel）

- **AaaS（Node/TS）が持つもの**
  - 対話フローの制御（Planner / Fast-path / Rule-based）
  - LLM / RAG / Hybrid Search の実行
  - セッション管理・安全性・レイテンシ管理
  - Webhook / ログ出力

> Notion は「何を話すか」を決める場所、AaaS は「どう話すか・どの順番で話すか」を決める場所、と整理できる。

---

## 🔗 連携の基本パターン

1. **定期同期 or 手動同期**
   - n8n が Notion DB を読み込み、AaaS 用の JSON / 設定ファイルを生成
   - 例: `notion-tuning-templates.json`, `notion-products.json` など

2. **Webhook / Event-driven 同期**
   - Notion 側の更新（行追加・変更）をトリガーに、AaaS 側の設定をリフレッシュ

3. **集計結果の書き戻し**
   - AaaS → Postgres → n8n → Notion
   - 例: usage_logs → Billing Summary、clarify_needed → Clarify Log

---

## 🔜 Phase13 でやること（Notion観点）

- Notion DB スキーマの確定（FAQ / Products / LP Points / TuningTemplates / ClarifyLog）
- n8n フローで Notion → AaaS 設定同期の MVP を作る
- Rule-based Planner / Sales Flow が Notion テンプレから動くようにする

詳細は:

- `NOTION_DB_SCHEMA.md`
- `NOTION_PIPELINE.md`
- `NOTION_SALES_FLOW.md`

を参照する。
