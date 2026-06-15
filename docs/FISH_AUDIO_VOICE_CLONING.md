# Fish Audio Voice Cloning — テナント別ブランド声質クローン

実装ステータス: Phase A/B/C 全完了（PR #344 / #358 / #359 / #365 / #410）

## 概要

各テナントが自社ブランドに合わせた音声をアバターに設定できる機能。Fish Audio S2-Pro の永続音声クローン機能（`reference_id` 方式）を活用し、音声サンプルをアップロードするだけでテナント専用の声質クローンを作成・適用できる。

---

## アーキテクチャ

### TTS フロー（Phase A/B-1 実装済み）

```
agent.py FishAudioTTS.synthesize()
  └─ テキスト組み立て
       ├─ SalesFlow 動的感情タグ（emotion_tags.py）
       ├─ テナント固定感情タグ（avatar_configs.emotion_tags × 3個）
       └─ 応答本文テキスト
  └─ POST https://api.fish.audio/v1/tts
       ├─ model: "s2-pro"              ← Phase A で明示指定
       ├─ reference_id: <voice_id>     ← テナント DB から解決
       ├─ format: "mp3"
       └─ latency: "balanced"
  └─ HTTP chunk streaming → LiveKit AudioFrame
       └─ Lemonslice 口パク同期
```

### 声質解決フロー（agent.py entrypoint）

```
/api/internal/avatar-config (tenantId) → avatar_configs
  └─ voice_id        → effective_reference_id（テナントクローン ID）
  └─ emotion_tags    → effective_emotion_tags（感情タグ JSON 配列）
  └─ 未設定          → reference_id なし（Fish Audio デフォルト音声）
```

---

## 機能詳細

### 1. S2-Pro モデル明示指定（Phase A — PR #344）

- `avatar-agent/agent.py`: `request_body["model"] = "s2-pro"` を明示
- `src/api/avatar/fishTtsRoutes.ts`: REST TTS エンドポイントも `model: "s2-pro"` に統一
- **理由**: デフォルト依存を排除し、将来のモデル変更の影響を受けない

### 2. HTTP chunk streaming（Phase B-1 — PR #358）

- `FishAudioChunkedStream._run()` で `resp.content.iter_chunked(4096)` による非同期チャンク受信
- TTFA（Time To First Audio）を HTTP 一括受信（旧: ~300–500ms）から ~200ms に短縮
- `streaming=True` を `TTSCapabilities` に設定し LiveKit Agents に chunk 転送を通知

### 3. 音声クローン作成 API（Phase B-2 — PR #359）

**エンドポイント**: `POST /v1/admin/avatar/configs/:id/voice-clone`

**認証**: Supabase Auth（client_admin / super_admin）。`tenantId` は JWT から取得。

**リクエスト**: `multipart/form-data`
| フィールド | 説明 |
|---|---|
| `audio` | 音声ファイル（MP3 / WAV / MP4 / M4A / OGG、最大 10MB） |
| `name` | クローン識別名（1〜100文字） |

**レスポンス**:
```json
{ "voiceId": "<fish-audio-model-id>" }
```

**内部フロー**:
1. テナント所有確認（`avatar_configs WHERE id = $1 AND tenant_id = $2`）
2. Fish Audio `POST https://api.fish.audio/model` で永続クローン作成（`visibility: private`）
3. 返却された `_id` を `avatar_configs.voice_id` に保存
4. 次回アバター起動時から `effective_reference_id` として使用される

**セキュリティ**:
- tenantId は JWT から取得のみ（body 禁止）
- super_admin は全テナント横断可、client_admin は自テナントのみ
- MIME タイプをバックエンド + フロントで二重チェック
- Fish Audio API の内部エラー詳細はログのみ（レスポンスには含めない）

### 4. Admin UI 音声クローン管理（Phase C-1 — PR #365）

**場所**: Admin UI `/admin/avatar/studio` ページ下部

**コンポーネント**: `admin-ui/src/pages/admin/avatar/StudioVoiceCloneSection.tsx`

**UI フロー**:
```
┌─────────────────────────────────────────┐
│ 🎙️ カスタム音声クローン                 │
│                                         │
│ 現在の音声 ID: [63bc41e6...]            │
│                                         │
│ [ドラッグ＆ドロップまたはファイル選択]  │
│  MP3 / WAV / MP4 / OGG、最大 10MB      │
│  推奨: 1〜2分、背景ノイズなし           │
│                                         │
│ クローン名: [____________________]      │
│                                         │
│ [クローン作成]                          │
│                                         │
│ ※ クローン作成後はこのアバターの現在   │
│   の声と置き換わります                  │
└─────────────────────────────────────────┘
```

**制約**:
- デフォルトアバター設定（`is_default = true`）ではクローン作成不可（ボタン無効化）
- 作成完了後に `onCloneSuccess(voiceId)` で親コンポーネントに通知し UI を更新

### 5. Fish Audio ASR（Transcribe-1）— PR #410

Web Speech API の代替として Fish Audio の音声認識 API を使用。ブラウザ互換性（Firefox 非対応）と精度の問題を解消する。

**エンドポイント**: `POST /api/voice/asr`

**認証**: `apiStack`（API キー認証）

**リクエスト**: `multipart/form-data`
| フィールド | 説明 |
|---|---|
| `audio` | 音声ファイル（audio/* MIME、最大 25MB） |

**レスポンス**:
```json
{ "text": "認識されたテキスト" }
```

**内部動作**:
- `POST https://api.fish.audio/v1/asr` に転送
- `language: "ja"`, `ignore_timestamps: "true"` 固定
- Widget 側の Web Speech API を完全に置換（PR #410 で widget.js の音声入力フローを更新）

---

## DB スキーマ（avatar_configs テーブル）

| カラム | 型 | 用途 |
|---|---|---|
| `voice_id` | `text` | Fish Audio reference_id（永続クローン ID） |
| `emotion_tags` | `jsonb` | テナント固定感情タグ配列（例: `["empathetic","calm"]`） |

**マイグレーション**: Phase A–C では不要（既存カラムを活用）

---

## 感情タグとの連動

感情タグは独立した 2 層構成（詳細: `docs/AVATAR_SALESFLOW_EMOTION_TAGS.md`）:

| 層 | ソース | タイミング |
|---|---|---|
| 静的テナントタグ | `avatar_configs.emotion_tags` | アバター起動時に固定 |
| 動的 SalesFlow タグ | `emotion_tags.py`（ステート別） | 各発話直前に注入 |

合成順: `[SalesFlow動的タグ] + [テナント固定タグ×3] + 本文テキスト`

---

## コスト

| 項目 | 単価 |
|---|---|
| S2-Pro TTS | $15 / M UTF-8 bytes（`costCalculator.ts` の `FISH_AUDIO_COST_PER_BYTE_USD`） |
| クローン作成 API | 無料（TTS 呼び出し時の通常料金のみ） |
| ASR（Transcribe-1） | Fish Audio 従量課金（別途確認） |

S1 → S2-Pro の単価変化なし。`costCalculator.ts` 変更不要。

---

## 未実装（将来フェーズ）

| 機能 | フェーズ | 理由 |
|---|---|---|
| インスタントクローン（`references` 配列） | Phase C-2 | 現行永続クローンで十分 |
| マルチスピーカーダイアログ | Phase D | 単一スピーカー用途では不要 |
| `enhance_audio_quality` オプション | 未定 | 推論コスト増・遅延増リスク |
| WebSocket ストリーミング | 未定 | HTTP chunk 転送で目標達成 |

---

## 実装ファイル一覧

| ファイル | 役割 |
|---|---|
| `avatar-agent/agent.py` | `FishAudioTTS` クラス、S2-Pro 指定、chunk streaming、voice_id 解決 |
| `avatar-agent/emotion_tags.py` | SalesFlow 動的感情タグマッピング（純粋関数） |
| `src/api/admin/avatar/routes.ts` | `POST /v1/admin/avatar/configs/:id/voice-clone` 実装 |
| `src/api/avatar/fishTtsRoutes.ts` | `POST /api/avatar/tts` REST TTS エンドポイント |
| `src/api/avatar/fishAsrRoutes.ts` | `POST /api/voice/asr` ASR エンドポイント |
| `admin-ui/src/pages/admin/avatar/StudioVoiceCloneSection.tsx` | 音声クローン管理 UI |
| `admin-ui/src/pages/admin/avatar/studio.tsx` | Studio ページへの統合 |
| `src/lib/billing/costCalculator.ts` | TTS コスト計算（変更なし） |
