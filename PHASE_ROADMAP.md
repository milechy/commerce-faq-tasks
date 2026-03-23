

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
