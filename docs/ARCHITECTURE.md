# Commerce-FAQ / Sales AaaS – Architecture

このプロジェクトは「Commerce-FAQ / Sales AaaS」として、EC/オンラインビジネス向けに **FAQ回答 + セールス支援** を行うエージェントを提供するバックエンドです。

- エンドユーザー向け: `/agent.search` で FAQ / セールストークを自動回答
- 運用者向け: `/admin/*` + React 管理 UI で FAQ を CRUD ＋ ES / pgvector を自動同期
- マルチテナント対応: `tenant_id` 列と `tenantId` パラメータでテナントごとにデータを分離
- 認証: Supabase Auth（管理 UI） + API Key / Basic 認証（エージェント API）

## 全体構成

### バックエンド（Node.js / TypeScript）

- ランタイム: Node 20 系推奨（開発では ts-node-dev）
- エントリポイント: `src/index.ts`
- 主な責務:
  - 認証ミドルウェア（API Key / Basic / Bearer）
  - Agent API: `/agent.search`
  - Admin API: `/admin/faqs` 系エンドポイント
  - Elasticsearch / PostgreSQL / Embedding API の呼び出し
  - 検索パイプライン（ES + pgvector ハイブリッド検索）のオーケストレーション

### 検索インフラ

- **Elasticsearch**
  - Index: `faqs`
  - 用途: FAQ ドキュメントのフルテキスト検索（BM25）
  - ドキュメントスキーマ（概念）:
    - `tenant_id`
    - `question`
    - `answer`
    - `category`
    - `tags` (array)

- **PostgreSQL + pgvector**
  - DB: `commerce_faq`
  - RDB で FAQ メタデータ＋ Embedding を管理
  - `faq_docs` … FAQ のソース・オブ・トゥルース（管理 UI が編集）
  - `faq_embeddings` … 検索用ベクトル（pgvector）

### Embedding / LLM レイヤー

- Embedding:
  - 現状: Groq API（`groq/compound-mini` など）を利用し、1536 次元のベクトルを生成
  - `faq_embeddings.embedding` (vector(1536)) に保存
  - `metadata` に `source`, `faq_id` などを保存
- LLM 応答生成:
  - ハイブリッド検索で取得した候補 FAQ から要約・回答文を生成
  - どの LLM を使うかは環境変数で差し替え可能な想定（OpenAI / Groq など）

### 管理 UI（admin-ui, React + Vite）

- `admin-ui/` 配下の Vite + React + TypeScript プロジェクト
- Supabase Auth を利用したログインページ（`Login.tsx`）
- 管理画面（`FaqList.tsx`）で:
  - Supabase Auth でログイン
  - 取得した JWT を使って Node バックエンドの `/admin/faqs` を呼び出し
  - FAQ 一覧・詳細・編集（answer 更新など）

## 主なリクエストフロー

### 1. エージェント API: `/agent.search`

1. クライアント（チャット UI 等）が `/agent.search` に POST:
   - ヘッダ: `x-api-key: <secret>` または Basic 認証
   - ボディ: `q`, `topK`, `tenantId`, `debug`, `useLlmPlanner` など
2. 認証ミドルウェアで API Key / Basic を検証
3. Planner が問い合わせを前処理（正規化・カテゴリ推定・フィルタ生成）
4. 検索パイプライン:
   - Elasticsearch でテキスト検索
   - pgvector で意味検索（`faq_embeddings`）
   - スコア正規化＆マージ
5. Reranker（ヒューリスティック）で上位 `topK` を選別
6. LLM で回答文を合成し、`answer` + `steps` + `ragStats` を返却

詳細は `docs/search-pipeline.md` と `docs/api-agent.md` を参照。

### 2. 管理 UI から FAQ 編集

1. 管理者が admin-ui の `Login` 画面で Supabase Auth にログイン
2. Supabase から返ってきた `access_token` を保持（例: メモリ / localStorage）
3. FaqList 画面で:
   - `Authorization: Bearer <access_token>` を付与して `/admin/faqs?tenantId=demo` を取得
   - FAQ 一覧を表示
4. 行をクリックして詳細を表示し、`answer` を編集
5. 保存時に以下が起こる:
   - Node バックエンドの `/admin/faqs/:id?tenantId=demo` に PUT
   - `faq_docs` の該当行を更新
   - Elasticsearch の `faqs` インデックス該当ドキュメントを更新
   - Groq Embedding API を使って新しいベクトルを生成し、`faq_embeddings` を upsert
6. 以降の `/agent.search` では更新後の内容で検索・回答される

詳細は `docs/api-admin.md`, `docs/db-schema.md` を参照。

## マルチテナント設計

- すべての FAQ / Embedding / ES ドキュメントには `tenant_id` が付与される
- `/agent.search` ではリクエストボディの `tenantId` を見て、ES / PG どちらもテナントフィルタ
- `/admin/faqs` もクエリ `tenantId` でテナントを指定
- テナントごとのデータ分離を保証しつつ、1 つのサーバー・1 つの DB / ES クラスタで運用

詳細は `docs/tenant.md` を参照。

## デプロイ前提

- インフラ例
  - Node バックエンド: Hetzner VPS 上で常駐（pm2 / systemd 等）
  - PostgreSQL 16 + pgvector
  - Elasticsearch 8 系
- 環境変数
  - `ES_URL` … Elasticsearch の URL
  - `DATABASE_URL` … PostgreSQL の接続文字列
  - `HYBRID_TIMEOUT_MS` … 検索パイプラインのタイムアウト
  - `SUPABASE_JWT_SECRET` … Supabase Auth の JWT 検証シークレット
  - `SUPABASE_PROJECT_URL`, `SUPABASE_ANON_KEY` … フロントエンド用
  - `GROQ_API_KEY` … Embedding 生成用

今後、AaaS としての **会話フローのチューニング（パートナー監修）** や、
Notion 等との連携は Phase8 以降で拡張していく前提です。

## Billing アーキテクチャ（AaaS）

本プロジェクトでは、AaaS 向けの Billing を次のコンポーネントで構成する。

- Usage Logging（アプリ DB）
  - `/agent.dialog`, `/agent.search`, `/search.v1` などのコア API から、1 リクエストごとに usage 情報を記録する。
  - 生ログから日次集計した結果を `usage_logs` テーブルとして保持する（tenant_id × date 単位）。
- Billing Orchestrator（n8n）
  - `usage_logs` を定期的に参照し、テナントごとの月次 Usage を集計する。
  - 集計結果を Stripe UsageRecord / Invoice に反映するフローを n8n で構成する。
- Stripe
  - Subscription（ベース料金）と Usage-based Billing（従量部分）を管理する。
  - Invoice 発行後、Webhook で決済ステータスをアプリ側に通知する。
- Notion Billing Summary
  - テナントごとの Billing 状況（プラン、請求履歴、メモ）を管理する Notion DB。
  - 必要に応じて、Stripe の Invoice URL やサマリ情報を同期する。

想定フロー（概要）:

1. アプリケーションサーバーは、各 API 呼び出し時に usage 情報を記録する（生ログ）。
2. 日次バッチまたは n8n フローにより、生ログから `usage_logs`（日次×テナント）を集計する。
3. 月次で n8n フローが `usage_logs` を元に Stripe UsageRecord / Invoice draft を作成する。
4. Stripe の Webhook 成功時に、Invoice URL / Status を Notion Billing Summary またはアプリ DB に反映する。
5. 管理 UI の「Billing / Usage」タブから、`usage_logs` と Stripe / Notion の情報を組み合わせて利用状況・請求状況を閲覧できるようにする。
