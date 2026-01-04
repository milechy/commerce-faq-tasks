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

# Notion DB Schema — Sales AaaS

Phase13 以降で想定している Notion DB のスキーマをまとめる。
実装段階で変更が入る可能性はあるが、ここを「初期の設計たたき台」とする。

---

## 1. FAQ DB

### 用途
- ユーザーのよくある質問と、それに対する一次回答（Q/A）を管理
- RAG の主要データソース

### 想定プロパティ

| プロパティ名 | 型 | 必須 | 説明 |
|--------------|----|------|------|
| Title (Question) | Title | ✅ | 質問文（ユーザー視点） |
| Answer | Rich text | ✅ | 回答テキスト（一次回答） |
| Tags | Multi-select | 任意 | カテゴリ・検索用タグ |
| Intent | Select | 任意 | shipping / returns / product-info / general など |
| Locale | Select | 任意 | ja / en など |
| Priority | Select | 任意 | high / medium / low |
| Published | Checkbox | ✅ | AaaS から参照して良いかどうか |

---

## 2. Products DB（教材 / 商品）

### 用途
- 英会話教材やプランなどの商品情報を一元管理
- Recommend / Propose / Upsell の材料になる

### 想定プロパティ

| プロパティ名 | 型 | 必須 | 説明 |
|--------------|----|------|------|
| Name | Title | ✅ | 商品名 / コース名 |
| Code | Rich text or Text | 任意 | 内部コード（SKU 等） |
| Level | Select | 任意 | beginner / intermediate / advanced など |
| Category | Select | 任意 | online / video / 1on1 / group など |
| Price | Number | 任意 | 価格（税抜 or 税込） |
| USP | Rich text | 任意 | Unique Selling Proposition（他と比べた強み） |
| Target Persona | Multi-select | 任意 | 学生 / 社会人 / 主婦 など |
| Features | Rich text | 任意 | 機能・特徴の箇条書き |
| Compare Tags | Multi-select | 任意 | 比較時に使うタグ（発音強化 / 実践会話 / 試験対策 など） |
| Active | Checkbox | ✅ | 現在販売中かどうか |

---

## 3. LP Points DB（LP/HP 訴求ポイント）

### 用途
- ランディングページの構成と訴求ポイントを構造的に保持
- AI が提案・クロージングする際の「根拠」として参照

### 想定プロパティ

| プロパティ名 | 型 | 必須 | 説明 |
|--------------|----|------|------|
| Section Title | Title | ✅ | セクション名（例: ユーザーの声） |
| Order | Number | 任意 | ページ内の表示順 |
| Key Message | Rich text | ✅ | そのセクションで伝えたいメインメッセージ |
| Evidence | Rich text | 任意 | 実績数字・根拠など |
| CTA Hint | Rich text | 任意 | ここから誘導したい CTA（無料体験 / 比較表など） |
| Persona | Multi-select | 任意 | 主なターゲットペルソナ |
| Active | Checkbox | ✅ | 現在利用するかどうか |

---

## 4. Tuning Templates DB（Sales 台本 / トーン）

### 用途
- Clarify / Propose / Recommend / Close / Objection Handling などの
  「営業話法テンプレート」を管理する最重要DB
- パートナー独自の心理学・営業ノウハウの入力ポイント

### 想定プロパティ

| プロパティ名 | 型 | 必須 | 説明 |
|--------------|----|------|------|
| Title | Title | ✅ | テンプレの用途が分かる名前 |
| Stage | Select | ✅ | clarify / propose / recommend / close / objection |
| Intent | Select | 任意 | shipping / returns / product-info / level_diagnosis など |
| Persona | Multi-select | 任意 | 対象ペルソナ（初心者 / ビジネス / 試験対策 など） |
| Body | Rich text | ✅ | 実際に出力される本文テンプレ（マクロ入り可） |
| CTA | Rich text | 任意 | 最後の一押し / 行動提案の文言 |
| Tone | Select | 任意 | simple / polite / salessoft など |
| Forbidden Phrases | Rich text | 任意 | 使ってはいけない表現（NGワード一覧） |
| Notes | Rich text | 任意 | パートナー向けメモ |
| Active | Checkbox | ✅ | 現在利用するテンプレかどうか |

---

## 5. Clarify Log DB

### 用途
- 実際に発生した Clarify を記録し、改善サイクルを回すためのログDB

### 想定プロパティ

| プロパティ名 | 型 | 必須 | 説明 |
|--------------|----|------|------|
| Query | Title | ✅ | ユーザーの元質問（抜粋） |
| Clarify Questions | Rich text | ✅ | AI が投げた Clarify 質問群 |
| Intent | Select | 任意 | shipping / returns / product-info / general など |
| Missing Fields | Multi-select | 任意 | product / region / level / goal など |
| Is Useful | Select | 任意 | useful / too much / unclear など |
| Suggestion | Rich text | 任意 | パートナーによる改善案 |
| Created At | Date | ✅ | 発生日時 |

---

## 6. Billing Summary / Usage DB（参考）

詳細は Billing 系の文書に任せるが、Notion 側では：

| プロパティ名 | 型 | 説明 |
|--------------|----|------|
| Tenant | Relation | テナント情報へのリンク |
| Month | Date | 対象月 |
| Total Requests | Number | リクエスト数 |
| LLM Cost | Number | LLMコスト |
| RAG Cost | Number | 検索コスト |
| Revenue | Number | 売上 |
| Margin | Number | 粗利 |
| Margin Rate | Number | 粗利率 |

---

## 7. 拡張候補

- Persona Profiles DB
- Campaigns / Promotions DB
- Sales Experiments DB（A/B テスト管理）

実装が進んだタイミングで別ドキュメントに切り出すことを想定している。