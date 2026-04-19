

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

---

## Phase28 – VPS本番デプロイ（完了）

- Hetzner VPS (65.108.159.161) での本番環境構築
- PM2によるプロセス管理（API: port 3100、Admin UI: port 5173）
- `bash SCRIPTS/deploy-vps.sh` による一括デプロイフロー
- rsync + ビルド + バンドル検証 + PM2 restart

Status: ✅ Completed (2026-03-05)

---

## Phase30-31 – Admin UI + テナント管理API（完了）

- Admin UI (React + Vite) 本番構築
- テナント管理API（CRUD、有効化/無効化）
- Supabase Auth 統合（JWT認証、role管理）
- super_admin / client_admin ロール分離

Status: ✅ Completed (2026-03-14)

---

## Phase32 – Billing Pipeline（完了）

- Stripe metered billing 統合
- Usage Tracking（usageTracker.ts、trackUsage()）
- テナント別月次集計・Invoice生成フロー

Status: ✅ Completed (2026-03-16)

---

## Phase36 – 認証フロー修正 + Admin UI品質向上（完了）

- Supabase JWT検証の安定化
- Admin UIエラーハンドリング改善
- プレビューモード（super_admin → client_admin切り替え）

Status: ✅ Completed (2026-03-17)

---

## Phase38 – 会話履歴 + チューニングルール（完了）

- Step1: chat_sessions / chat_messages テーブル作成 + チャット保存
- Step2: 会話履歴API（GET /v1/admin/chat-history/sessions）
- Step3: 会話履歴Admin UI（一覧・詳細ページ）
- Step4: tuning_rules CRUD（BE: routes.ts / FE: tuning/index.tsx）
- Step5: LLMプロンプト注入（synthesisTool.ts でチューニングルール適用）
- Step6: テナント別システムプロンプト（tenants.system_prompt カラム + LLM注入）
- Step7: テスト + VPSデプロイ完了

Status: ✅ Completed (2026-03-24)

詳細: [docs/PHASE38_COMPLETION.md](docs/PHASE38_COMPLETION.md)

---

## Phase39 – UI品質向上（完了）

- Mobile First対応（390px viewport、タッチターゲット44px以上）
- ダークテーマ統一
- エラーメッセージの日本語化・UX改善

Status: ✅ Completed (2026-03-19)

---

## Phase40 – Lemonslice Avatar統合（完了）

- LiveKit + Lemonslice Self-Managed Avatar + Fish Audio TTS
- `avatar-agent/agent.py`: Groq LLM + Fish Audio TTS + Lemonslice AvatarSession
- `public/widget.js`: フルスクリーンアバターUI（Shadow DOM）
- `/api/avatar/room-token`: LiveKit JWT発行 + Agent Dispatch
- テナント機能フラグ `features.avatar` によるON/OFF制御

Status: ✅ Completed (2026-03-20)

---

## Phase41 – Avatar Customization Studio（完了）

- `avatar_configs` テーブル CRUD API（`/v1/admin/avatar/configs`）
- 画像生成: Leonardo.ai (PHOENIX + PHOTOGRAPHY preset、4枚生成)
- 声マッチング: Fish Audio (language=ja フィルタ + 0件時フォールバック)
- プロンプト生成: Groq LLM → system_prompt + emotion_tags
- Admin UI: アバタースタジオ（画像生成/アップロード/声/プロンプト）
- Admin UI: アバター一覧ページにテストチャットボタン追加
- base64画像 → Supabase Storage HTTP URL変換
- `SCRIPTS/migrate-base64-to-supabase.ts` 既存データ変換スクリプト
- agent_id / agent_image_url 排他制御（LemonSlice制約対応）
- `/api/avatar/room-token` レスポンスに image_url を含める
- widget.js: LiveKit接続前プレースホルダー画像表示

Status: ✅ Completed (2026-03-23)

---

## Phase42 – Anam.ai移行（中止）

- 概要: Lemonslice → Anam.ai への一本化を試みた
- 中止理由: Anam の日本語 TTS が不十分（カタコト・不自然な発音）
- 検証結果: CARA-3モデルの画像品質は合格だったが、日本語音声品質が本番利用に耐えない
- 結論: **Lemonslice + Fish Audio + LiveKit の現行構成を維持**
- 一部成果: Leonardo.ai画像生成統合（DALL-E置き換え）は Phase41 に取り込み済み
- DB: `avatar_configs` に `anam_*` カラムは追加済み（後方互換、将来再検討時に使用可能）

Status: ❌ Cancelled (2026-03-22)

---

## Phase43 – 管理画面 AI アシスタント（完了）

- `admin_feedback` テーブル CRUD API（フィードバックチケット管理）
- `POST /v1/admin/ai-assist/chat` — インテント振り分け + RAG 統合
- 管理画面サポート AI システムプロンプト（RAJIUCE 知識ベース）

Status: ✅ Completed (2026-03-25)

---

## Phase44 – 心理学 RAG 基盤（完了）

- 書籍 PDF アップロード API（AES-256-GCM 暗号化保存、Supabase Storage `book-pdfs`）
- チャンク構造化パイプライン（pdf-parse → 500–1000 文字分割 → Groq llama-3.1-8b-instant 6 フィールド構造化 → Embedding + faq_embeddings）
- パートナー向け書籍管理 UI（ドラッグ&ドロップアップロード、処理進捗表示）
- 心理学原則 RAG 検索統合（principleDetector → SalesFlow 注入）
- DBマイグレーション: `book_uploads` テーブル + `faq_embeddings` metadata インデックス
- Supabase Storage: `book-pdfs` バケット（private）

Status: ✅ Completed (2026-04-05)

---

## Phase45 – Judge評価ループ（完了）

- Gemini 2.5 Flash をJudge（評価者）として実装（Generator: Groq と別モデルファミリで自己評価バイアス回避）
- 4軸スコアリング: `psychology_fit` 30% / `customer_reaction` 25% / `stage_progress` 25% / `taboo_violation` 20%
- `conversation_evaluations` テーブル + CRUD API (`/v1/admin/evaluations/*`)
- 低スコア時のチューニングルール自動提案（`suggested_rules` → `tuning_rules` にdraft挿入）
- Admin UI: 評価ダッシュボード + KPI推移表示
- few-shot calibration 例をJudgeプロンプトに含める（スコアドリフト防止）
- `src/lib/gemini/client.ts`: Gemini APIクライアント

Status: ✅ Completed

---

## Phase46 – Knowledge Gap検出（完了）

- 4トリガーによるギャップ検出: `no_rag`（RAG結果なし）, `low_confidence`（低信頼度）, `fallback`（フォールバック応答）, `judge_low`（Judge低スコア）
- `knowledge_gaps` テーブル + CRUD API (`/v1/admin/knowledge-gaps/*`)
- Gemini搭載推薦エンジン: ギャップからFAQ/チューニングルールの追加候補を自動生成
- Admin UI: ギャップ一覧 + インライン知識追加機能

Status: ✅ Completed

---

## Phase47 – Psychology Book RAG構造化（完了）

- PDF書籍を6フィールド構造化チャンクに分解: `situation`, `resistance`, `principle`, `contraindication`, `example`, `failure_example`
- `bookStructurizer.ts` + `bookChunker.ts`: Gemini 2.5 Flash で構造化 → pgvector + ES に保存
- Admin UI: PDF書籍管理 (`/admin/knowledge/books`)
- `metadata.source = 'book'` で書籍チャンクを識別、`metadata.principle` で心理原則フィルタ
- `ragExcerpt.slice(0, 200)` 厳守（書籍内容保護）
- `SCRIPTS/structurize-existing-books.ts`: 既存書籍の再構造化スクリプト

Status: ✅ Completed

---

## Phase48 – LLM防御レイヤー L5-L8

- **L5: Input Sanitizer** (`src/middleware/inputSanitizer.ts`) — ユーザー入力の前処理・無害化
- **L6: Prompt Firewall** (`src/middleware/promptFirewall.ts`) — プロンプトインジェクション検出・ブロック
- **L7: Topic Guard** (`src/middleware/topicGuard.ts`) — 話題逸脱検出（営業文脈外の話題をブロック）
- **L8: Output Guard** (`src/middleware/outputGuard.ts`) — LLM出力の後処理・有害内容フィルタ
- E2E Bug修正:
  - Bug-1: SHA-256 hashApiKey 一貫性テスト + Input Sanitizer 共存テスト追加
  - Bug-2: features.avatar=false テナントへのアバター開通を 403 でブロック
  - Bug-3: client_admin の avatar configs 取得で自テナント外が見えるバグ修正

Status: ✅ Completed

---

## Phase49 – HTTPS/SSL設定（完了）

- r2c.biz ドメイン取得（Cloudflare Registrar）
- Nginx reverse proxy: `api.r2c.biz` → `:3100`、`admin.r2c.biz` → `:5173`
- Let's Encrypt SSL（certbot --nginx、自動更新）
- CORS / ALLOWED_ORIGINS の HTTPS 対応
- Widget 埋め込み URL の HTTPS 化（`https://api.r2c.biz/widget.js`）

Status: ✅ Completed

---

## Phase50 – 会話分析ダッシュボード（完了）

- Analytics集計API 3エンドポイント: summary / trends / evaluations
- Admin UI ダッシュボードページ（/admin/analytics）
- KPIカード4枚（総会話数、Judgeスコア、Knowledge Gap、アバター利用率）
- chart.js折れ線（会話数トレンド）、ドーナツ（スコア分布）、レーダー（4軸平均）
- 低スコア会話テーブル（session_idリンク付き）
- 期間フィルター（7d/30d/90d）+ テナントセレクター（super_admin用）
- RBAC: super_admin=全テナント、client_admin=自テナント強制
- DBマイグレーション不要（既存テーブルへのSELECTのみ）

Status: ✅ Completed

---

## Phase51 – 日本語BERTセンチメント分析（完了）

- Python Sentiment Service（FastAPI :8200 + koheiduck/bert-japanese-finetuned-sentiment）
- PM2管理: rajiuce-sentiment（CPU推論、メモリ約500MB）
- 非同期sentiment分析: customerメッセージ保存後にfire-and-forget
- `chat_messages.sentiment` JSONBカラム追加（label/score/raw_label）
- LLMヒント注入: 直近3メッセージのsentimentからトーン調整ヒントを生成
- Analytics API拡張: sentiment_distribution + 日次sentiment推移
- ダッシュボードUI: センチメントKPIカード + スタックバーチャート + パイチャート
- 依存: fugashi + unidic-lite + ipadic（MeCab日本語トークナイザー）

Status: ✅ Completed

---

## Phase52 – Widget L1-L4 セキュリティ強化（完了）

- L1: Rate Limiter（IPベース、テナント別設定）
- L2: API Key 認証強化（SHA-256ハッシュ検証、定数時間比較）
- L3: Tenant Context Loader（JWTからtenantId抽出、body禁止）
- L4: Security Policy Enforcer（CORS、CSP、XSS防御）
- Widget Shadow DOM セキュリティ強化

Status: ✅ Completed (2026-03-24)

---

## Phase53 – 書籍ナレッジPDFパイプライン（完了）

- PDF → 6フィールド構造化チャンク（Gemini 2.5 Flash）
- pgvector + Elasticsearch への保存
- Admin UI: 書籍管理ページ（ドラッグ&ドロップ、処理進捗）
- `metadata.source = 'book'` による書籍チャンク識別
- `ragExcerpt.slice(0, 200)` 厳守（書籍内容保護）

Status: ✅ Completed (2026-04-03)

---

## Phase54 – 従量課金（完了）

- Stripe metered billing 統合強化
- テナント別使用量トラッキング精度向上
- 請求ダッシュボード Admin UI
- Usage Alert（閾値超過時Slack通知）

Status: ✅ Completed (2026-04-04)

---

## Phase55 – 行動イベントレイヤー（完了）

- `behavioral_events` テーブル + イベント収集API
- Widget側: scroll / time_on_page / page_transition イベント送信
- テンポラリースコア算出ロジック（スクロール深度 × 滞在時間 × 訪問ページ数）
- イベントストリーム集計 + Analytics API拡張

Status: ✅ Completed (2026-04-04)

---

## Phase56 – プロアクティブエンゲージメント（完了）

- テンポラリースコア閾値によるプロアクティブ介入トリガー
- 介入タイミング最適化（離脱意図検出、高関心検出）
- A/Bテスト対応（介入メッセージのバリアント管理）
- Widget: プロアクティブメッセージ表示UI

Status: ✅ Completed (2026-04-04)

---

## Phase57 – コンテキストアウェア・セールスエージェント（完了）

- 行動イベント × 心理学RAG × SalesFlow の統合
- 訪問者コンテキスト（デバイス・ページ・スコア）を LLM プロンプトに注入
- 心理原則のリアルタイム選択（Judge評価フィードバック反映）
- セールスステージ追跡（clarify → propose → recommend → close）

Status: ✅ Completed (2026-04-04)

---

## Phase58 – コンバージョン最適化ループ（完了）

- Judge評価 × A/Bテスト × コンバージョントラッキングの自動ループ
- 低スコアパターン自動検出 → チューニングルール提案
- コンバージョンファネル分析ダッシュボード
- 週次レポート自動生成（Slack通知付き）

Status: ✅ Completed (2026-04-04)

---

## Phase59 – ZIP PDFアップロード（完了）

- 複数PDFをZIPで一括アップロード・展開
- セキュリティ制約付き（ファイルタイプ検証、サイズ制限）
- テスト: 978件 → 986件（+8）

Status: ✅ Completed (2026-04-06)

---

## Phase60 – pgvector統合 + クロステナント匿名コンテキスト + Perplexityディープリサーチ（完了）

### Phase60-A: 全提案機能へのpgvector接続
- 4つのLLM提案機能すべてにpgvectorナレッジ検索を接続
- 提案品質向上（コンテキスト付き回答生成）

### Phase60-B: クロステナント匿名コンテキスト
- テナント横断の匿名統計注入
- コンバージョン追跡修正

### Phase60-C: Perplexityディープリサーチ統合
- Perplexity API連携によるリアルタイムWeb検索
- テナント別ON/OFFトグル（Admin UIから設定可能）
- モバイルレスポンシブ対応（390px、ディープリサーチカード）

テスト: 988件 → 1043件（+55）

Status: ✅ Completed (2026-04-09)

---

## Phase61-63 – オプション代行サービス（完了）

- Asana GID: 1214050763911954
- `option_orders` テーブル（FK → `tenants(id)`）、CRUD API（`/v1/admin/options/*`）、R2C 機能カタログ実装
- `feedbackAI` 代行提案フロー: カタログ + LLM 判定ハイブリッド → 料金試算 (70B) → 承諾 → DB 保存 + 通知送信
- オプション管理 UI（`/admin/options`、SuperAdminRoute）、`POST /v1/admin/notifications`（SA → テナント宛送信）
- `NotificationBell` TYPE_ICON 拡張（`option_ordered` 🛒 / `option_scheduled` 📅 / `option_completed` 🎉）
- `FeatureUsed` 型に `option_service` 追加

主要コミット:
- `3c070d5` feat: Phase61-63 option delegation service (DB + API + chat flow + admin UI + notifications)
- `6e60269` fix: option_orders migration FK references tenants(id)

Status: ✅ Completed (2026-04-14)

---

## Phase64 – アバター高度化（完了）

- 全 6 タスク + UI 改善 3 件を実施
- `agent.py` DB 値優先フォールバック + 1920×1080 解像度対応
- Fish Audio 18 体音声割り当て（日本語 16 体 + 英語 2 体）
- ウィジェット大型表示（PC 900px / 3fr:2fr グリッド）、6 ステップ生成ウィザード（fal.ai Flux 2 Pro）
- プレミアムパイプライン（Magnific AI 高解像度化）、代行サービスオプション `premium_avatar` 追加
- UI: PC グリッド 4 列、R2C デフォルト紫バッジ、ホバーアニメーション、画像コピー防止、ソート全修正、テナントフィルタ厳密化
- demo 重複 18 体 DB 削除済み

主要コミット:
- `8a70d92` feat(avatar): Phase64 — agent.py DB値優先フォールバック + 1920x1080
- `c5cdc35` feat(avatar): Phase64 — Fish Audio 18体音声割り当て + migration SQL
- `b45913c` feat(widget): Phase64 — アバターUI大型表示対応 + 音声migration SQL
- `ac46617` feat(avatar): Phase64-タスク4 — fal.ai Flux Pro 6ステップ生成ウィザード
- `241f385` feat(avatar): Phase64-タスク5 — Flux 2 Pro + Magnific AI プレミアム生成パイプライン
- `ae02497` feat(avatar): Phase64-タスク6 — プレミアムアバター制作代行フロー
- `5fa8a93` feat(ui): Phase64追加 — アバター管理ページ レスポンシブグリッド改善

Status: ✅ Completed (2026-04-15)

---

## Phase65 – コンバージョントラッキング（完了 + 派生タスク進行中）

- デモサイトシミュレーション（carnation-demo 9 ページ構成、CV 発火シミュレーション）
- `trackConversion()` → `conversion_attributions` へのブリッジ実装
- Analytics API 拡張、`CVUnfiredAlert`、`cv_fired_status` エンドポイント
- テスト: 1043 件 → 1122 件（+79）

派生タスク:
- **Phase65-2**: パートナー向けコンバージョン計測実装ガイド（`docs/CONVERSION_TRACKING_GUIDE.md`）→ PR #110 + #115 で完了（2026-04-19）
- **Phase65-4**: carnation ロールアウト計画 → Asana 1214121023204382（2026-05-09 期限）

主要コミット:
- `eb1644a` feat(demo): Phase65-1 carnation-demo 9ページ構成に拡張、CV発火シミュレーション追加
- `c9a8ffd` fix(events): Phase65 chat_conversion → conversion_attributions ブリッジ追加
- `b551a99` feat(analytics): Phase65-3 CV指標・cv-statusエンドポイント・CVUnfiredAlert

Status: ✅ Completed (2026-04-09) / 派生タスク進行中

---

## Phase66 – R2C 仮想テナント追加 + carnation 誤表示修正（完了）

- Asana GID: 1214115420756112
- `src/api/admin/tenants/migration_r2c_default.sql` で `r2c_default` テナント新設（enterprise プラン、`avatar:true`、billing 無効）
- `avatar_configs` の `is_default=true` 18 体を `carnation` → `r2c_default` に UPDATE
- `livekitTokenRoutes.ts` Q2（`OR is_default=true` → `OR tenant_id='r2c_default'`）、Q3 に `ORDER BY created_at DESC` 追加
- `admin-ui/src/pages/admin/tuning/index.tsx:91` super_admin フォールバック修正（Codex P2 指摘反映: `MOCK_TENANTS[0]?.value`）
- 1117 テスト全 pass + 本番反映済み
- 関連: chat-test 画面 UX 改善（Asana 1214115421896831）と admin-ui vitest（Asana 1214115484987893）は別タスク

主要コミット:
- `0faf117` feat(phase66): R2C default virtual tenant + carnation misattribution fix
- `0d9a09d` fix(ui): デフォルトアバターのテストボタンでavatarConfigId優先、carnationアバター誤表示解消

Status: ✅ Completed (2026-04-18)
