# 環境変数追加申請
## 使い方
新しい環境変数が必要な場合、ここに追記してください。
統合役が .env / deploy.yml にマージ時に追加します。

## 申請フォーマット
- 変数名: 説明 / デフォルト値 (Stream, Phase番号)

## 申請リスト
（まだなし）

## Phase44 (Stream A)
- SUPABASE_URL: 確認のみ（Phase41追加済み）
- SUPABASE_SERVICE_ROLE_KEY: 確認のみ（Phase41追加済み）
- KNOWLEDGE_ENCRYPTION_KEY: 書籍暗号化に流用（Security Fix追加済み、未設定時は平文フォールバック）

Supabase Storage: book-pdfs バケット（private）を Supabase Dashboard で手動作成すること

## Security Fix: RAG暗号化 (fix/security-rag-excerpt-limit)
- KNOWLEDGE_ENCRYPTION_KEY: faq_embeddings.text 暗号化キー（64文字hex = 256bit AES-256-GCM）
  - 生成方法: `python3 -c "import secrets; print(secrets.token_hex(32))"`
  - 未設定の場合は平文保存のままフォールバック（console.warnを出力）
  - 既存データのマイグレーション: `DATABASE_URL=... KNOWLEDGE_ENCRYPTION_KEY=... tsx SCRIPTS/encrypt-existing-embeddings.ts`

## Phase32 (Stream A)
- STRIPE_SECRET_KEY: Stripe APIシークレットキー（sk_live_xxx / sk_test_xxx） (Stream A, Phase32)
- STRIPE_WEBHOOK_SECRET: Stripe Webhookエンドポイントシークレット（whsec_xxx） (Stream A, Phase32)
- BILLING_PORTAL_RETURN_URL: Stripe Customer Portal からの返遷先URL / "https://example.com" (Stream A, Phase32)

DBスキーマ変更: src/lib/billing/migration.sql を実行すること
- 新規テーブル: stripe_subscriptions, usage_logs, stripe_usage_reports

## Phase31 (Stream A)
- SUPER_ADMIN_BYPASS: development環境でSuper Admin認証をバイパス / "true" (Stream A, Phase31)
- SUPABASE_JWT_SECRET: Supabase JWT検証シークレット（既存変数、Phase31で必須化）

DBスキーマ変更: src/api/admin/tenants/migration.sql を実行すること
- 新規テーブル: tenants, tenant_api_keys

## Phase45 (Stream A)
- JUDGE_AUTO_EVALUATE: 会話完了時の自動Judge評価 / "true" (Phase45)
- JUDGE_SCORE_THRESHOLD: 自動ルール提案のスコア閾値 / "60" (Phase45)

## Phase46 (Stream A)
- GAP_DETECTION_ENABLED: Knowledge Gap自動検出 / "true" (Phase46)
- GAP_CONFIDENCE_THRESHOLD: rerankスコアのGap判定閾値 / "0.3" (Phase46)
- `GEMINI_API_KEY`: Google AI Studio APIキー（gapRecommender.ts で使用）
- `GEMINI_MODEL`: Gemini モデル名（省略時: `gemini-2.5-flash-preview-04-17`）

## Phase47 (Stream A)
- `BOOK_STRUCTURIZE_ENABLED`: 書籍テキスト構造化パイプライン有効化 / `"true"` — 未設定または `"true"` 以外の場合は `structurizeBook()` が即時返却 (Phase47)
- `GEMINI_API_KEY`: Phase46で追加済み。bookStructurizer.ts も同一キーを使用
- `GEMINI_MODEL`: Phase46で追加済み。bookStructurizer.ts も同一モデルを使用
- `OPENAI_API_KEY`: Phase47で embedding 生成（text-embedding-3-small）に使用。既存変数
- `ES_FAQ_INDEX`: ESインデックス名（省略時: `faqs`）。既存変数

## Phase48: LLM防御 L5-L8

**既定値の決まり方（`src/middleware/securityLayerConfig.ts`）**:
`NODE_ENV` が `development` / `test` の時だけ既定OFF（`"true"` 明示でON）。
それ以外（`production` / `staging` / **`NODE_ENV`未設定**）はすべて既定ON（`"false"` 明示でOFF）。
未知の環境名を「本番かもしれない」側に倒す fail-safe。

> ⚠️ **ローカル開発では `.env` に `NODE_ENV=development` が必要**（`.env.example` に記載済み）。
> `pnpm dev` / `pnpm start` は `NODE_ENV` を設定しないため、未設定のままだと4層が既定ONになり、
> 開発中にURL送信ブロック等が効き始める。
>
> 逆に本番側は、`pm2 start` に `--env production` を付け忘れると `NODE_ENV` が未設定になる。
> 以前はこれで**4層すべてが無言でOFF**になっていた（fail-open）。現在は既定ONに倒れる。

| 変数 | 説明 / デフォルト | Phase |
|---|---|---|
| INPUT_SANITIZER_ENABLED | 入力サニタイザー有効化 / 既定ON（dev/testのみOFF） | Phase48 |
| INPUT_MAX_LENGTH | 最大メッセージ長 / 500 | Phase48 |
| PROMPT_FIREWALL_ENABLED | プロンプトファイアウォール有効化 / 既定ON（dev/testのみOFF） | Phase48 |
| PROMPT_FIREWALL_SHADOW_ENABLED | 文中インジェクションのshadow計測（ブロックしない） / 既定ON（dev/testのみOFF） | Phase48 |
| TOPIC_GUARD_ENABLED | トピックガード有効化 / 既定ON（dev/testのみOFF） | Phase48 |
| TOPIC_GUARD_LLM_ENABLED | トピックガードLLM判定 / false | Phase48 |
| OUTPUT_GUARD_ENABLED | 出力ガード有効化 / 既定ON（dev/testのみOFF） | Phase48 |
| SESSION_ABUSE_LIMIT | セッション終了までの違反回数 / 3 | Phase48 |
| SESSION_REPEAT_LIMIT | 同一メッセージ反復ブロック回数 / 3 | Phase48 |

### 難読化による検出回避への対策（L7）

全角英字（`ａｃｔ ａｓ`）やゼロ幅スペース（`a<ZWSP>ct as`）を使うと、ASCII前提の
検出パターンを100%回避できていた。現在は L7 が **検査専用の正規化コピー**（NFKC +
不可視文字の除去/空白化の2通り）を作り、「正規化すると禁止パターンに一致するが
原文のままでは一致しない」場合を意図的な難読化とみなしてメッセージ全体をブロックする。

- **LLMに渡る本文は原文のまま**（正規化コピーは判定にのみ使用）。正当な全角入力は壊さない
- 難読化の痕跡は全角ASCII（U+FF01-FF5E）と不可視文字のみ。**半角カナは含めない**
  （`ﾘｾｯﾄ方法を教えて` のような正常な問い合わせを誤ブロックしないため）
- ブロック時は `[promptFirewall] obfuscated injection blocked` を **warn** で常時記録
  （`PROMPT_FIREWALL_SHADOW_ENABLED` に依存しない）。本文はログに出さない
- 検出名は `<パターン名>_obfuscated`（例: `role_override_en_obfuscated`）
