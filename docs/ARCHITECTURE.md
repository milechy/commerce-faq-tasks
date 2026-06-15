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
  - 現状: Groq API（`GROQ_COMPOUND_MINI` = `groq/compound-mini`）を利用し、1536 次元のベクトルを生成
  - `faq_embeddings.embedding` (vector(1536)) に保存
  - `metadata` に `source`, `faq_id` などを保存
- LLM 応答生成:
  - ハイブリッド検索で取得した候補 FAQ から要約・回答文を生成
  - モデル ID は `src/config/groqModels.ts` に集約（単一の真実）。呼び出し元は定数 import 経由
  - デフォルト: `GROQ_VERSATILE_70B` / 複雑クエリ・safety: `GPT_OSS_120B`（比率 ≤10%）
  - 保守手順・EOL 検知層の詳細: `docs/GROQ_MODELS.md`

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

## Avatar アーキテクチャ（Phase40-41）

### 現行構成（Lemonslice + Fish Audio + LiveKit）

```
Widget (widget.js)
  └─ POST /api/avatar/room-token
       └─ LiveKit Room 作成 + Agent Dispatch
            └─ avatar-agent/agent.py (LiveKit Agents v1.4+)
                 ├─ Groq LLM (llama-3.3-70b-versatile)
                 ├─ Fish Audio TTS (language=ja、reference_id で声指定)
                 └─ Lemonslice AvatarSession (agent_id または agent_image_url)
```

### Avatar設定管理

- `avatar_configs` テーブルでテナント別アバター設定を管理
- Admin UI `/admin/avatar/studio` で設定（画像生成・声マッチング・プロンプト生成・音声クローン作成）
- 画像: Leonardo.ai で生成 → Supabase Storage にアップロード → HTTP URL を保存
- 声: Fish Audio (language=ja フィルタ) で検索・選択、またはテナント独自音声クローンを作成
- `is_active = true` の設定が `/api/internal/avatar-config` 経由で agent.py に渡される

### avatar_provider フィールド

`avatar_configs.avatar_provider` は将来のプロバイダー切り替えに備えたフィールド。
**現在は全テナント `lemonslice` を使用。**

`anam_*` カラム（`anam_avatar_id`, `anam_voice_id`, `anam_persona_id`, `anam_llm_id`）は
Phase42 (Anam.ai移行試み) で追加したが、**Phase42は中止**となり現在は使用していない。
後方互換のためカラムは残存しており、将来 Anam.ai の日本語品質が改善した際に再検討可能。

### Phase42（Anam.ai移行）中止について

Phase42 では Lemonslice から Anam.ai への一本化を試みたが、以下の理由で中止した:

- **中止理由**: Anam の日本語 TTS が不十分（カタコト・不自然な発音）
- **検証結果**: CARA-3 モデルの画像品質は合格だったが、日本語音声品質が本番利用に耐えない
- **現状**: Lemonslice + Fish Audio + LiveKit の現行構成を維持
- **成果の継承**: Leonardo.ai 画像生成統合（DALL-E 置き換え）は Phase41 に取り込み済み

**2026-04-19 追記**: Anam 関連テスト (`tests/phase48/avatarFeatureFlag.test.ts`) を削除。
`ts-jest@29` + `jest@30` のバージョン不一致による `jest.mock` hoisting 問題により、
hkobayashi の環境で非決定的に失敗していたため。`anamRoutes.ts` 本体は将来再検討のため残存。
根本原因の解消は別タスク（ts-jest 30.x アップグレード）で検討予定。

### SalesFlow × Fish Audio S2 感情タグ連動（PR #406）

SalesFlow の会話ステート（clarify / propose / recommend / close）に連動して、Fish Audio S2 の感情インラインタグを各発話に動的注入する機能。静的なテナント固定タグ（`avatar_configs.emotion_tags`）と独立した per-utterance 動的レイヤーを `avatar-agent/emotion_tags.py` が提供する。

詳細: `docs/AVATAR_SALESFLOW_EMOTION_TAGS.md`

### アバター沈黙ゼロ化 — thinking_start フィラー機構（PR #402）

LLM 応答生成中にアバターが無音になる「沈黙」を DataChannel ベースのフィラー発話で埋める。

#### フロー

```
Widget                          agent.py
  │                                │
  ├─ /api/chat 呼び出し直前         │
  │   publishData({type:"thinking_start"}) ──→ on_data_received
  │                                │     └─ session.say("少々お待ちください",
  │                                │          allow_interruptions=True)
  │                                │          → _filler_state["handle"] に保存
  │                                │
  ├─ /api/chat レスポンス受信        │
  │   publishData({type:"tts_request", text:"…"}) ──→ handle_tts_request
  │                                │     └─ _filler_state["handle"].interrupt()
  │                                │          → session.say(prefix + reply_text)
```

#### 実装詳細

- **Widget 側** (`public/widget.js`): `/api/chat` fetch 直前に `thinking_start` を DataChannel で publish。
  条件: `avatarProvider === 'lemonslice'` かつ `window.__rajiuceRoom.localParticipant` が存在する場合のみ。
  失敗は non-fatal（try/catch で無視してフロー継続）。
- **Agent 側** (`avatar-agent/agent.py`): `_filler_state: dict = {"handle": None}` でフィラーハンドルを保持。
  - `thinking_start` 受信 → `session.say("少々お待ちください", allow_interruptions=True)` 開始、ハンドルを保存。
  - `tts_request` 受信 → `fh.interrupt()` でフィラーを中断し、本来の応答テキストを `session.say()` で再生。

#### 設計上の注意

- 当初タスク名の `ctx.with_filler()` は livekit-agents 1.6.0 の `RunContext` 専用 API であり、
  現行 SDK (1.5.17) には存在しない。DataChannel 経由の代替設計で同等の体験を実現している。
- フィラー文言（"少々お待ちください"）はハードコード。多言語テナント対応は別タスク（P2）。
- `thinking_start` 連打時のキュー管理（asyncio.Lock）は未実装。別タスク（P2）。
- livekit-agents 1.6.0 へのバージョン bump と `ctx.with_filler()` ネイティブ移行も別タスク（P2）。

### SalesFlow × 商品カード同期表示 — LiveKit Data Tracks（Asana #99021）

`recommend` ステージで返す商品カードをアバターの発話開始タイミングと同期して表示する設計。REST レスポンス到着時に即時表示する現行方式の 500ms〜1s のズレを解消し、アバターが喋り始めた瞬間にカードが現れる体験を実現する。

Data Flow の変更点: Widget が `tts_request` に `productCard` を同乗させ → agent.py がTTS 開始直後に `product_card` イベントを Data Channel で返送 → Widget が DataReceived で受信してカードを描画。

詳細: `docs/SALESFLOW_PRODUCT_CARD_LIVEKIT.md`

### テナント別ブランド声質クローン — Fish Audio Voice Cloning（Phase A/B/C — PR #344/#358/#359/#365）

テナントが自社専用の音声クローンをアバターに設定できる差別化機能。

**TTS フロー**:
- `avatar-agent/agent.py` の `FishAudioTTS` が `s2-pro` モデルを明示指定
- `avatar_configs.voice_id` を `reference_id` として Fish Audio API に送信（テナント別声質）
- HTTP chunk streaming（`iter_chunked(4096)`）で TTFA ~200ms を実現

**音声クローン作成**:
- `POST /v1/admin/avatar/configs/:id/voice-clone`（multipart: `audio` + `name`）
- Fish Audio `POST /model` で永続クローン作成 → `voice_id` を DB 保存
- Admin UI `/admin/avatar/studio` の `StudioVoiceCloneSection` から操作可能

詳細: `docs/FISH_AUDIO_VOICE_CLONING.md`

### Fish Audio ASR — Transcribe-1 音声認識（PR #410）

Web Speech API の代替として Fish Audio の音声認識 API を導入。Firefox 非対応・ネットワーク依存の問題を解消。

- エンドポイント: `POST /api/voice/asr`（multipart `audio`、最大 25MB）
- 実装: `src/api/avatar/fishAsrRoutes.ts`
- `language: "ja"`, `ignore_timestamps: true` 固定
- Widget の音声入力フローを Web Speech API から本エンドポイントへ完全置換
