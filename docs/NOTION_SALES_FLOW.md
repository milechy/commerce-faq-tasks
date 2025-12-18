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

# Notion-driven Sales Flow — Clarify / Propose / Recommend / Close

このドキュメントでは、Sales AaaS の「営業フロー」を Notion から制御する前提で、
Sales Flow と Notion DB（特に Tuning Templates / Products / LP Points）との関係を整理する。

---

## 🎯 目的

- セールスフロー（Clarify → Propose → Recommend → Close）を、
  コードではなく **Notion のテンプレート編集だけでチューニングできる状態** にする
- パートナーの心理学・営業ノウハウを、Notion のテキストとして安全に注入できるようにする

---

## 1. Sales Flow の4ステージ

Sales AaaS の基本ステージは以下の4つ：

1. **Clarify**
   - ユーザーの状況・目標・制約などを質問して、条件を揃える
2. **Propose**
   - 現状と目標に基づき、「こういう方向性が良さそうです」という提案をする
3. **Recommend**
   - 複数の商品 / プランから、合いそうなものを 1〜3 個ピックアップして比較・推奨する
4. **Close**
   - 行動提案（CTA）を出す。例: 無料体験 / 問い合わせ / 資料請求 など

これらの各ステージに対して、**Notion 側にテンプレを用意しておく**。

---

## 2. Notion Tuning Templates との対応

`Tuning Templates DB` では、各ステージに応じたテンプレートを管理する。

### 2-1. プロパティ再掲（抜粋）

- `Stage`: clarify / propose / recommend / close / objection
- `Intent`: shipping / returns / product-info / level_diagnosis / goal_setting など
- `Persona`: 初心者 / ビジネス / 試験対策 など
- `Body`: 実際のメッセージ本文
- `CTA`: 最後の一押し文言（close 用）
- `Tone`: simple / polite / salessoft
- `Forbidden Phrases`: NG ワード

### 2-2. Sales Flow 実行時のテンプレ選択ロジック（例）

1. AaaS の Planner が intent / persona / stage を決定
2. Notion から次の条件でテンプレを Query：
   - `Stage == 現在のステージ`
   - `Intent == 現在の intent（あれば）`
   - `Persona にユーザーのペルソナが含まれる`
   - `Active == true`
3. ヒットしたテンプレの中から 1件を選択（最初は simple に最初の1件でOK）
4. `Body` / `CTA` / `Tone` を LLM に渡して最終文面に反映

---

## 3. LP Points / Products との連携

### 3-1. Propose / Recommend で使う情報

- **Products DB**
  - ユーザーのレベル / 目標 /制約に合う商品をフィルタリング
  - price / level / USP / CompareTags などを使ってレコメンド

- **LP Points DB**
  - 提案の裏付けとして LP の訴求ポイントを引用
  - 例: 「3ヶ月で日常会話レベル」という実績数字

### 3-2. 具体イメージ（英会話教材）

1. Clarify: 「英会話でどんな場面を想定していますか？」などを質問
2. Propose: 「◯ヶ月後に △△ な状態を目指すプランはいかがでしょうか」
3. Recommend: Products DB から 2〜3 プランを比較表示（特徴・価格・向き不向き）
4. Close: 「まずは7日間の無料体験から始めてみませんか？」

これらの文面は **すべて Notion 上のテンプレと商品データから組み立てる**。

---

## 4. Clarify Log とチューニングサイクル

Clarify が発生した対話は、Webhook → n8n → Notion Clarify Log DB に保存される。

パートナーは Clarify Log を見て：

- Clarify が冗長なケース
- 意図が伝わっていない Clarify
- そもそも不要だった Clarify

を発見し、

1. `Tuning Templates DB` の Clarify テンプレを修正
2. 必要なら `FAQ DB` や `Products DB` を補強

というループを回す。

> Clarify Log = 「どこを直せば Sales Flow が滑らかになるか」の地図。

---

## 5. Phase13 の実装ゴール（Sales Flow 観点）

- AaaS の Planner で stage / intent / persona を決定
- Notion Tuning Templates から該当テンプレを取得
- Products / LP Points を参照しつつ Propose / Recommend / Close を生成
- Clarify 発生時は Clarify Log に書き戻す

これにより、**Sales Flow の中身は全て Notion 編集で制御可能**になる。