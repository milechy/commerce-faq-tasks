# 本番 .env プレースホルダ残存チェック — 調査レポート

> **Asana GID**: 1215190164957424  
> **調査日**: 2026-05-28  
> **対象ファイル**: `.env.example`, `.env.production.example`, `docs/DEPLOY_CHECKLIST.md`

---

## 調査概要

`FAL_KEY=<your-fal-key>` 等のプレースホルダ文字列が本番 `.env` に残存していないかを確認する。
本番 VPS (`/opt/rajiuce/.env`) には直接アクセスできないため、以下の手順でオペレーター側での確認を促す。

---

## 1. 発見されたプレースホルダパターン一覧

### `.env.example` 内のプレースホルダ (コピー元テンプレート)

| キー | テンプレート値 | パターン種別 | 重要度 |
|---|---|---|---|
| `SUPABASE_URL` | `https://YOUR_PROJECT.supabase.co` | `YOUR_*` | P0 (Auth 無効) |
| `SUPABASE_JWT_SECRET` | `your-jwt-secret` | `your-*` | P0 (JWT 検証不能) |
| `SUPABASE_SERVICE_ROLE_KEY` | `your-service-role-key` | `your-*` | P0 (Admin API 不能) |
| `GROQ_API_KEY` | `gsk_xxxx` | `*_xxxx` | P0 (LLM 応答不能) |
| `GEMINI_API_KEY` | `your-gemini-api-key` | `your-*` | P1 (Judge/Gap 機能停止) |
| `LIVEKIT_URL` | `wss://your-livekit.livekit.cloud` | `your-*` | P1 (Avatar 機能停止) |
| `LIVEKIT_WS_URL` | `wss://your-livekit.livekit.cloud` | `your-*` | P1 (Avatar 機能停止) |
| `LIVEKIT_API_KEY` | `your-livekit-key` | `your-*` | P1 (Avatar 機能停止) |
| `LIVEKIT_API_SECRET` | `your-livekit-secret` | `your-*` | P1 (Avatar 機能停止) |
| `FISH_AUDIO_API_KEY` | `your-fish-audio-key` | `your-*` | P1 (Audio 機能停止) |
| `STRIPE_SECRET_KEY` | `sk_test_xxxx` | `*_xxxx` | P1 (Billing 停止) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_xxxx` | `*_xxxx` | P1 (Billing Webhook 無効) |
| `POSTHOG_PROJECT_API_KEY` | `phc_xxxx` | `*_xxxx` | P1 (Analytics 無効) |

### `.env.production.example` 内のプレースホルダ

| キー | テンプレート値 | パターン種別 | 重要度 |
|---|---|---|---|
| `DATABASE_URL` | `postgres://postgres:CHANGE_ME@...` | `CHANGE_ME` | P0 (DB 接続不能) |
| `AGENT_API_KEY` | `CHANGE_ME` | `CHANGE_ME` | P0 (Auth 全失敗) |

### `FAL_KEY` の特記事項

- `.env.example` では `FAL_KEY=` (空文字) — プレースホルダテキストなし
- コード (`falGenerationRoutes.ts:99`) で `process.env.FAL_KEY?.trim()` を確認し、未設定時は HTTP 500 を返す
- タスク起票理由: 本番 `.env` に `FAL_KEY=<your-fal-key>` が残存した可能性
- **`<your-fal-key>` はプレースホルダとして認識できず、trim() 後も空文字にならないため黙って 500 エラーになる**

---

## 2. 本番環境検出コマンド (オペレーター手動実行)

VPS で以下を実行し、出力があれば未設定キーが残存している:

```bash
# SSH 経由でオペレーターが実行
# ※ bash SCRIPTS/deploy-vps.sh 経由でのみ VPS にアクセスすること (CLAUDE.md 規定)
ssh root@65.108.159.161 "grep -E '=(your-|YOUR_|CHANGE_ME|_xxxx|<your-)' /opt/rajiuce/.env || echo 'OK: no placeholders found'"
```

### 検出パターン説明

| パターン | 意味 | 例 |
|---|---|---|
| `your-*` | テンプレートの `your-` 系プレースホルダ | `your-jwt-secret` |
| `YOUR_*` | 大文字プレースホルダ | `YOUR_PROJECT.supabase.co` |
| `CHANGE_ME` | 明示的な変更要求プレースホルダ | `CHANGE_ME` |
| `_xxxx` | API キーのダミー値 | `gsk_xxxx` |
| `<your-` | 角括弧プレースホルダ | `<your-fal-key>` |

---

## 3. 重要度分類

### P0 — アプリ起動不能 / 全チャット停止

これらが未設定または偽値の場合、アプリ全体が停止する:

- `DATABASE_URL` (DB 接続不能)
- `GROQ_API_KEY` (LLM 応答不能)
- `SUPABASE_JWT_SECRET` (JWT 検証エラーで全 API 認証失敗)
- `SUPABASE_SERVICE_ROLE_KEY` (Admin 操作不能)
- `AGENT_API_KEY` (API 認証全失敗)

### P1 — 機能単位で停止 (Avatar / Billing / Analytics)

アバター機能が有効 (`FF_AVATAR_ENABLED=true`) な場合にのみ P0 に昇格:

- `FAL_KEY` — `falGenerationRoutes` / `premiumGenerationRoutes` が HTTP 500
- `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — LiveKit 接続失敗
- `FISH_AUDIO_API_KEY` — 音声合成失敗

---

## 4. `env-check.sh` の現状と不足点

現行の `SCRIPTS/env-check.sh` は:
- ✅ コード内 `process.env.*` と `.env.example` の対応確認
- ❌ プレースホルダ値の検出なし (`your-*` / `CHANGE_ME` パターン)
- ❌ 実際の `.env` ファイルを読まない (existence check のみ)

**フォローアップ推奨**: `SCRIPTS/env-check.sh` にプレースホルダ検出ロジックを追加 (Tier B skill タスクとして起票)。

---

## 5. `.env.example` の一貫性問題

プレースホルダ形式が混在しており、コピー元として紛らわしい:

| 形式 | 件数 | 例 |
|---|---|---|
| 空文字 (`KEY=`) | 多数 | `FAL_KEY=`, `OPENAI_API_KEY=` |
| `your-*` テキスト | 7件 | `GROQ_API_KEY=gsk_xxxx` |
| `CHANGE_ME` | 2件 (production.example) | `AGENT_API_KEY=CHANGE_ME` |
| `YOUR_*` | 2件 | `SUPABASE_URL=https://YOUR_PROJECT...` |

**推奨**: 未設定 = 空文字 (`KEY=`) に統一し、「要設定」マーカーコメントを追加。または全キーを `CHANGE_ME` で統一。

---

## 6. DEPLOY_CHECKLIST.md への追加項目

`docs/DEPLOY_CHECKLIST.md` の **Pre-deploy (ローカル)** セクションに以下を追加済み (本 PR で反映):

```
- [ ] 本番 .env プレースホルダ残存なし
      確認: grep -E '=(your-|YOUR_|CHANGE_ME|_xxxx|<your-)' .env
```

---

## まとめ

| 項目 | 結果 |
|---|---|
| `.env.example` 内プレースホルダ | 13 キー (7種パターン) |
| `.env.production.example` 内 | 2 キー (CHANGE_ME) |
| `FAL_KEY` の状態 | `.env.example` は空文字 (安全)。本番で `<your-fal-key>` 残存を疑って調査 |
| 検出コマンド | 上記 §2 参照 |
| フォローアップ | `env-check.sh` プレースホルダ検出機能追加 (Tier B skill) |
