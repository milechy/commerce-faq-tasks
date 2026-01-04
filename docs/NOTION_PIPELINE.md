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

# Notion Integration Pipeline — n8n × AaaS × Postgres

Notion と Sales AaaS 間のデータ連携を、n8n を中心に整理したドキュメント。

---

## 🎯 目的

- パートナーは **Notion だけを編集** すればよく、コード変更やデプロイ不要にする
- AaaS は **Notion の内容を定期的 or イベント駆動で同期** し、
  - Rule-based Planner
  - Sales Flow（Clarify/Propose/Recommend/Close）
  - RAG データ
  に反映する
- 実行ログや Billing 結果は、逆向きに Notion へ集約する

---

## 1. 全体フロー概要

```text
Notion DB
  ↓ (n8n: Fetch & Transform)
AaaS Config JSON / DB
  ↓
AaaS Runtime (Planner / RAG / SalesFlow)
  ↓
Postgres (usage_logs, dialog_logs, etc.)
  ↓ (n8n: Aggregate & Map)
Notion (Billing Summary, Clarify Log, Funnel)
```

---

## 2. Notion → AaaS 設定同期フロー

### 2-1. トリガー

- 手動実行（Phase13 の初期はこれでOK）
- 将来的には：
  - 定期スケジュール（例: 5分 or 1時間ごと）
  - Notion 変更検知（Webhook が使えれば理想）

### 2-2. n8n ノード構成（例）

1. **Manual / Schedule Trigger**
2. **Notion: FAQ DB を Query**
3. **Notion: Products DB を Query**
4. **Notion: LP Points DB を Query**
5. **Notion: Tuning Templates DB を Query**
6. **Function ノードで JSON 形式に整形**
   - AaaS 側の型（TypeScriptの型）に合わせる
7. **HTTP Request or DB ノード**
   - AaaS の `/admin/config/notion-sync` のようなエンドポイントに送る
   - または Postgres の設定テーブルに直接 upsert

### 2-3. AaaS 側の受け取り

- `notion_faq`, `notion_products`, `notion_lp_points`, `notion_tuning_templates` などのテーブル or JSON キャッシュに保存
- Rule-based Planner / Sales Flow / RAG がそれらを参照するように実装

---

## 3. AaaS → Notion ログ同期フロー

### 3-1. 対象ログ

- usage_logs（dialog / search / tokens / cost）
- dialog_logs（clarify_needed / completed / error）
- sales_funnel（clarify → propose → recommend → close の到達）

### 3-2. n8n ノード構成（例）

1. **Schedule（毎日 or 毎時）**
2. **Postgres: usage_logs 集計クエリを実行**
3. **Function: Notion プロパティにマッピング**
4. **Notion: Billing Summary DB に upsert**

Clarify Log や Funnel の場合：

1. **Webhook (agent.dialog.clarify_needed)**
2. **Function: ペイロードから必要な項目抽出**
3. **Notion: Clarify Log DB に 1レコード追加**

---

## 4. エラー / 監視

- n8n フロー内で失敗した場合:
  - Slack などに通知（`#alerts` チャンネル）
  - リトライポリシーを設定（再実行）
- 重要なエラー例:
  - Notion API エラー（レートリミット / 認可エラー）
  - Postgres 接続エラー
  - AaaS 側エンドポイントへの送信失敗

---

## 5. Phase13 の MVP 範囲

Phase13 でまず対応するのは：

1. **Notion → AaaS（片方向）**
   - FAQ / Products / LP Points / TuningTemplates の同期
   - AaaS の設定 or Postgres に反映

2. **Clarify Log の書き込み（AaaS → Notion）**
   - `agent.dialog.clarify_needed` Webhook を受けて Notion Clarify Log DB に保存

Billing Summary や Funnel 集計は、Phase14 以降の対象とする。