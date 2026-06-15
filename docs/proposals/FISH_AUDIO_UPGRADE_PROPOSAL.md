# Fish Audio S2-Pro 全機能統合 実装提案書

> 作成日: 2026-06-10  
> 対象ブランチ: 新規 `feature/<asana-id>-fish-audio-upgrade`  
> 前提: 現状コード実機調査済み（`avatar-agent/agent.py`, `src/api/avatar/fishTtsRoutes.ts`, `src/api/admin/avatar/routes.ts`, `src/lib/billing/costCalculator.ts`）

---

## 1. 現状ギャップ分析

### 1.1 現在の実装状態

| 機能 | 実装状態 | ファイル | 問題点 |
|------|---------|---------|--------|
| Fish Audio TTS 呼び出し | ✅ 動作中 | `avatar-agent/agent.py:218` | モデル未指定（S1デフォルト） |
| 音声クローン (reference_id) | ✅ DBから取得 | `agent.py:237` | 動く |
| 感情タグ (emotion_tags) | ⚠️ DBには保存 | `routes.ts:118` | TTS呼び出しに**注入されていない** |
| WebSocket ストリーミング | ❌ 未実装 | `agent.py:177` | `streaming=False` ハードコード |
| S2-Pro 明示指定 | ❌ 未指定 | `agent.py:231` | Fish Audio側のデフォルトに依存 |
| 永続クローン管理 UI | ❌ 未実装 | — | 音声ファイルのアップロード・クローン作成機能なし |
| インスタントクローン | ❌ 未実装 | — | `references` 配列形式未対応 |
| fish-audio-sdk 活用 | ❌ 未使用 | `requirements.txt:5` | インストール済みだが aiohttp 直接呼び出し |
| REST TTS エンドポイント | ⚠️ 動作中 | `fishTtsRoutes.ts:43` | reference_id がハードコード |
| コスト計算 | ✅ 実装済み | `costCalculator.ts:33` | S2-Pro 単価 $15/M bytes は正確 |

### 1.2 S2-Pro で新たに使える機能（未活用）

```
S2-Pro 新機能                現状のギャップ
─────────────────────────────────────────────────────
[bracket] 自然言語感情制御   → emotion_tags はDBにあるが TTS テキストに挿入されていない
80+ 言語自動検出            → 日本語テキストはそのまま送信（変わらず機能するが最適化余地）
マルチスピーカーダイアログ  → 未検討
TTFA 100ms                  → streaming=False で活かせていない（HTTP 一括受信）
enhance_audio_quality       → リクエストボディに未設定
```

---

## 2. 実装フェーズ設計

### Phase A — 即効・低リスク（推定 1 日）

**変更ファイル 2 本、Gate 1 通過見込み高**

#### A-1: S2-Pro モデル明示指定

**対象**: `avatar-agent/agent.py:231`、`src/api/avatar/fishTtsRoutes.ts:41`

```python
# avatar-agent/agent.py — request_body に追加
request_body = {
    "text": self._input_text,
    "model": "s2-pro",          # ← 追加
    "format": "mp3",
    "normalize": True,
    "latency": "balanced",
}
```

```typescript
// fishTtsRoutes.ts — body に追加
body: JSON.stringify({
  text: text,
  model: 's2-pro',              // ← 追加
  reference_id: referenceId || '63bc41e652214372b15d9416a30a60b4',
  format: 'mp3',
  latency: 'balanced',
}),
```

**リスク**: ゼロ。Fish Audio のモデル ID `s2-pro` は 2026-03 から本番稼働・公式認定。  
**影響範囲**: アバター音声の品質向上のみ。既存テストへの影響なし（TTS は外部モック）。

---

#### A-2: 感情タグの TTS テキスト自動注入

**対象**: `avatar-agent/agent.py`（`FishAudioTTS.__init__` と `synthesize`）

現状: `emotion_tags: ["empathetic","calm"]` が DB に保存されているが、TTS 呼び出し時に一切使われていない。

**実装方針**: `FishAudioTTS.__init__` に `emotion_tags: list[str]` を追加し、`synthesize` 時にテキスト先頭へ `[empathetic][calm]` 形式で挿入。

```python
class FishAudioTTS(agents_tts.TTS):
    def __init__(
        self,
        api_key: str,
        reference_id: str | None = None,
        tenant_id: str | None = None,
        emotion_tags: list[str] | None = None,   # ← 追加
    ):
        ...
        self._emotion_tags = emotion_tags or []

    def synthesize(self, text: str, *, conn_options=...) -> "FishAudioChunkedStream":
        # タグ挿入: 3個まで（過剰タグは音質劣化リスクあり）
        prefix = "".join(f"[{t}]" for t in self._emotion_tags[:3])
        tagged_text = f"{prefix}{text}" if prefix else text
        return FishAudioChunkedStream(..., input_text=tagged_text, ...)
```

`entrypoint` での初期化部分:

```python
effective_emotion_tags = (
    avatar_config.get("emotion_tags") if avatar_config else None
) or []
# emotion_tags は JSON 文字列として格納されている場合に parse
if isinstance(effective_emotion_tags, str):
    import json as _j
    effective_emotion_tags = _j.loads(effective_emotion_tags)

fish_tts = FishAudioTTS(
    api_key=os.environ["FISH_AUDIO_API_KEY"],
    reference_id=effective_reference_id,
    tenant_id=tenant_id,
    emotion_tags=effective_emotion_tags,    # ← 追加
)
```

**DB 確認事項**: `avatar_configs.emotion_tags` が JSON 配列として格納されているか VPS で要確認。
```sql
-- 確認クエリ
SELECT id, name, emotion_tags, pg_typeof(emotion_tags)
FROM avatar_configs
WHERE emotion_tags IS NOT NULL
LIMIT 5;
```

**副作用**: タグが空の場合（既存アバター設定なし）は動作変化なし。

---

#### A-3: fishTtsRoutes.ts のハードコード reference_id 修正

**対象**: `src/api/avatar/fishTtsRoutes.ts:29,43`

現状: `process.env.FISH_AUDIO_REFERENCE_ID` が未設定の場合、ハードコードの ID `63bc41e652214372b15d9416a30a60b4` にフォールバックしている。これはテナント別ではない。

**修正**: `voiceId` を `req.body` で受け取れるようにし、環境変数フォールバックは残しつつハードコード ID を削除。Fish Audio は `reference_id` 省略時にデフォルト音声を使用するため安全。

```typescript
// fishTtsRoutes.ts — POST /api/avatar/tts body に voice_id を追加受付
const { text, voiceId } = req.body;
const effectiveReferenceId = voiceId || process.env.FISH_AUDIO_REFERENCE_ID?.trim() || undefined;
// undefined の場合は Fish Audio がデフォルト音声を使用（安全）
```

**影響**: widget.js からの呼び出しフローを事前 grep 確認（下記チェックリスト参照）。

---

### Phase B — 中規模実装（推定 2–3 日）

**Gate 1–3 全パス前提、LiveKit SDK 互換確認が必須**

#### B-1: HTTP ストリーミング対応（低遅延化）

**目的**: HTTP 一括受信（現状 ~300–500ms）からチャンク転送（TTFA ~200ms）へ移行し、Lemonslice 口パク同期を改善。WebSocket は複雑度が高いため HTTP チャンクを先行実装。

**技術前提確認**（実装前に VPS で実行）:
```bash
python3 -c "
from livekit.agents.tts import AudioEmitter
import inspect
print(inspect.signature(AudioEmitter.initialize))
"
```

**実装方針**:

```python
# FishAudioTTS.__init__ — streaming=True に変更
super().__init__(
    capabilities=agents_tts.TTSCapabilities(streaming=True),
    sample_rate=44100,
    num_channels=1,
)

# FishAudioChunkedStream._run — chunk 転送
output_emitter.initialize(
    request_id=f"fish-audio-{id(self)}",
    sample_rate=self._tts.sample_rate,
    num_channels=self._tts.num_channels,
    mime_type="audio/mpeg",
    stream=True,   # ← True に変更
)
async with http_session.post("https://api.fish.audio/v1/tts", ...) as resp:
    async for chunk in resp.content.iter_chunked(4096):
        if chunk:
            output_emitter.push(chunk)
output_emitter.flush()
```

**リスク**: LiveKit Agents の `stream=True` が lemonslice プラグインと互換か未検証。  
**必須**: staging VPS での実機テスト（TTFA 計測 200ms 以下が合格基準）。  
互換問題が発生した場合は `streaming=False` を維持し、HTTP chunk 転送のみ実装（flush タイミングを変える）。

---

#### B-2: 永続音声クローン管理 API

**目的**: 管理者がテナント専用の音声ファイルをアップロードし、Fish Audio で永続クローンを作成して `avatar_configs.voice_id` に保存できるようにする。

**新規エンドポイント**: `POST /api/admin/avatar/:configId/voice-clone`

```typescript
// src/api/admin/avatar/routes.ts 内に追加
// multipart/form-data: audio file
app.post('/api/admin/avatar/:configId/voice-clone',
  supabaseAuthMiddleware, requireAvatarOwnership,
  multer({ limits: { fileSize: 10 * 1024 * 1024 } }).single('audio'),
  async (req, res) => {
    const { configId } = req.params;
    const { name } = req.body;
    const audioFile = req.file;

    // 1. Fish Audio POST /model (FormData)
    const fd = new FormData();
    fd.append('visibility', 'private');
    fd.append('type', 'tts');
    fd.append('title', name);
    fd.append('voices', new Blob([audioFile.buffer], { type: audioFile.mimetype }), 'voice.mp3');

    const fishRes = await fetch('https://api.fish.audio/model', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${FISH_AUDIO_API_KEY}` },
      body: fd,
    });
    const { _id: voiceId } = await fishRes.json();

    // 2. avatar_configs.voice_id を更新（tenantId は JWT から）
    await db.query(
      'UPDATE avatar_configs SET voice_id = $1 WHERE id = $2 AND tenant_id = $3',
      [voiceId, configId, tenantId]
    );

    return res.json({ voiceId });
  }
);
```

**セキュリティ考慮**:
- `tenantId` は JWT から取得（body 禁止 — CLAUDE.md 準拠）
- MIME タイプ検証: `audio/mpeg`, `audio/wav`, `audio/mp4`, `audio/ogg` のみ許可
- `requireAvatarOwnership` ミドルウェアで他テナントのアバター設定変更を防止

**必須テスト**:
- `avatarAuthGuard.test.ts` に voice-clone エンドポイントの auth guard テスト追加
- 他テナント ID での変更試みが 403 を返すことを確認

---

### Phase C — 大規模実装（推定 4–5 日）

#### C-1: Admin UI 音声クローン管理

**対象**: `admin-ui/src/pages/admin/avatar/studio.tsx`

**追加コンポーネント**: 音声クローン管理セクション

```
┌─────────────────────────────────────┐
│ 🎙️ カスタム音声クローン             │
│                                     │
│ 現在の音声 ID: [63bc41e6...]        │
│                                     │
│ [音声ファイルをアップロード]        │
│  .mp3/.wav/.m4a, 最大10MB           │
│  推奨: 1〜2分、背景ノイズなし       │
│                                     │
│ クローン名: [____________]          │
│                                     │
│ [クローン作成] ← B-2 API を呼ぶ    │
│                                     │
│ ※ 作成には30〜60秒かかります       │
└─────────────────────────────────────┘
```

**影響**: `studio.tsx` のみ（新規セクション追加）。  
既存の voice_description → voice_id 検索フロー（`generationRoutes.ts`）とは独立して動作。

---

#### C-2: インスタントクローン対応

**目的**: `reference_id`（永続クローン）に加え、1回限りの音声参照（`references` 配列）をサポート。  
**用途**: デモ時にユーザーの声でリアルタイム音声生成（将来の差別化機能）。

```python
# agent.py — references 配列サポート追加
if self._reference_audio_bytes:
    request_body["references"] = [{
        "audio": base64.b64encode(self._reference_audio_bytes).decode(),
        "text": self._reference_text or "",
    }]
elif self._reference_id:
    request_body["reference_id"] = self._reference_id
```

**優先度**: 低（現状の永続クローンで十分）。Phase B-2 の完了後に検討。

---

#### C-3: マルチスピーカーダイアログ（Phase D 以降）

S2-Pro の独占機能。複数スピーカーが登場するコンテンツ生成（FAQ 解説動画、商品デモナレーション等）に有用。現状のアバター音声（単一スピーカー）には不要なため **Phase D 以降**で検討。

---

## 3. 影響ファイル一覧

| フェーズ | ファイル | 変更種別 | 変更規模 |
|---------|---------|---------|---------|
| A-1 | `avatar-agent/agent.py` | 修正 | 1行追加 |
| A-1 | `src/api/avatar/fishTtsRoutes.ts` | 修正 | 1行追加 |
| A-2 | `avatar-agent/agent.py` | 修正 | ~20行追加 |
| A-3 | `src/api/avatar/fishTtsRoutes.ts` | 修正 | ~5行変更 |
| B-1 | `avatar-agent/agent.py` | 修正 | ~30行変更 |
| B-2 | `src/api/admin/avatar/routes.ts` | 修正 | ~60行追加 |
| B-2 | `src/api/admin/avatar/avatarAuthGuard.test.ts` | テスト追加 | ~40行 |
| C-1 | `admin-ui/src/pages/admin/avatar/studio.tsx` | 修正 | ~80行追加 |
| C-2 | `avatar-agent/agent.py` | 修正 | ~20行 |

**変更なし（影響なし）のファイル**:

| ファイル | 理由 |
|---------|------|
| `src/lib/billing/costCalculator.ts` | S2-Pro 単価は既存の `$15/M bytes` と同一 |
| `src/lib/billing/usageTracker.ts` | TTS バイト計上ロジック変更不要 |
| `src/api/internal/usageRoutes.ts` | ttsTextBytes 計上フロー変更なし |
| `src/lib/avatar/voiceSettings.ts` | Fish Audio API は speed/pitch 非対応。S2-Pro は自動最適化 |
| `public/widget.js` | TTS は server-side のみ |
| `src/index.ts` | route 登録変更なし |
| `.env` / `ecosystem.config.cjs` | 新規 env var なし（`FISH_AUDIO_API_KEY` は既存） |
| `src/lib/billing/costCalculator.ts` の `FISH_AUDIO_COST_PER_BYTE_USD` | S1/S2-Pro どちらも $15/M bytes で同一 |

---

## 4. DB 変更

**Phase A–B では DB マイグレーション不要。** 既存カラムを活用:

| カラム | テーブル | 用途 | 現状 |
|-------|---------|------|------|
| `emotion_tags` | `avatar_configs` | JSON 配列 | 保存済み、TTS 未接続 |
| `voice_id` | `avatar_configs` | Fish Audio reference_id | 設定済みアバターあり |

**Phase B-2 前に VPS で実行する確認クエリ**:

```sql
-- voice_id の現在の使用状況
SELECT tenant_id, name, voice_id, voice_description
FROM avatar_configs WHERE voice_id IS NOT NULL LIMIT 20;

-- emotion_tags の格納形式確認
SELECT name, emotion_tags, pg_typeof(emotion_tags)
FROM avatar_configs WHERE emotion_tags IS NOT NULL LIMIT 5;
```

---

## 5. リスク・依存関係マトリクス

| リスク | 対象 Phase | 影響度 | 回避策 |
|--------|-----------|--------|--------|
| LiveKit ChunkedStream `stream=True` が lemonslice と未互換 | B-1 | 高 | staging で計測先行。問題なら stream=False のまま chunk 転送に留める |
| Fish Audio `/model` POST 仕様変更 | B-2 | 中 | OpenAPI `api.fish.audio/openapi.json` で事前確認 |
| 感情タグがテキスト品質を下げる | A-2 | 低 | 3タグ上限。日本語テキストで staging 確認 |
| multer 10MB 音声ファイルの PM2 メモリ | B-2 | 低 | limits 設定済み。大ファイルは 400 拒否 |
| fish-audio-sdk 1.3.0 の S2-Pro 対応 | B-1 方針B | 中 | SDK CHANGELOG 確認。未対応なら aiohttp 直接呼び出しを継続 |

---

## 6. Gate 通過要件

### Phase A
- Gate 1: `pnpm verify` — TypeScript 変更のみ、型エラーなし
- Gate 1.5: dead-code-check — 関数追加のみで dead export なし
- Gate 2: `bash SCRIPTS/security-scan.sh` — ハードコード ID 削除で gitleaks 誤検知なし確認
- Gate 3: `pnpm build && cd admin-ui && pnpm build`

### Phase B
- Gate 1–3 に加え: VPS ステージングでの TTFA 計測（200ms 以下）
- `avatarAuthGuard.test.ts` に voice-clone auth guard テスト追加

### Phase C
- Gate 1–3 に加え: `pnpm test:e2e` — avatar studio ページで UI 表示確認

---

## 7. 実装順序と推奨 Asana タスク構成

```
Phase A (1日) — 同一 PR 可
  ├─ A-1: S2-Pro モデル指定 (2ファイル / 2行)
  ├─ A-2: 感情タグ TTS 注入 (agent.py / ~20行)
  └─ A-3: fishTtsRoutes reference_id ハードコード修正

Phase B (3日) — A 完了後
  ├─ B-1: HTTP ストリーミング (staging テスト必須)
  └─ B-2: 音声クローン API + auth guard テスト

Phase C (5日) — B 完了後
  ├─ C-1: Admin UI クローン管理 (studio.tsx)
  └─ C-2: インスタントクローン (agent.py)

Phase D (未定)
  └─ C-3: マルチスピーカーダイアログ
```

---

## 8. 実装前チェックリスト

### Phase A 着手前（必須）

```bash
# 1. emotion_tags の格納形式を VPS DB で確認
psql $DATABASE_URL -c "SELECT name, emotion_tags, pg_typeof(emotion_tags) FROM avatar_configs WHERE emotion_tags IS NOT NULL LIMIT 5;"

# 2. Fish Audio で s2-pro モデルが有効か確認
curl -s -o /dev/null -w "%{http_code}" -X POST https://api.fish.audio/v1/tts \
  -H "Authorization: Bearer $FISH_AUDIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"テスト","model":"s2-pro","format":"mp3"}'
# 200 が返れば OK

# 3. widget.js での reference_id 使用箇所確認
grep -n "tts\|fishAudio\|reference_id\|63bc41e6" public/widget.js | head -20
```

### Phase B-1 着手前（必須）

```bash
# LiveKit Agents AudioEmitter.initialize シグネチャ確認
python3 -c "
from livekit.agents.tts import AudioEmitter
import inspect
print(inspect.signature(AudioEmitter.initialize))
"

# fish-audio-sdk の WebSocket API 確認
python3 -c "from fish_audio_sdk import AsyncSession; help(AsyncSession.tts)" 2>&1 | head -30
```

---

## 9. コスト影響

| 項目 | 変化 |
|------|------|
| S1 → S2-Pro 単価 | 変化なし（どちらも $15/M UTF-8 bytes）|
| `costCalculator.ts` 変更 | 不要 |
| 音声クローン作成 API コスト | 無料（TTS 呼び出し時の通常料金のみ） |
| ストリーミング化によるコスト | 変化なし（API 呼び出し回数は同じ） |

---

## 10. 却下項目

| 項目 | 却下理由 |
|------|---------|
| `voiceSettings.ts` の `speakingRate`/`pitch` を Fish Audio に渡す | Fish Audio API は speed/pitch パラメータを持たない |
| Gemini TTS への乗り換え | Fish Audio S2-Pro が TTS-Arena2 #1。移行コストに見合わない |
| Fish Audio ASR 導入 | VAD/STT は LiveKit 側で処理。スコープ外 |
| `enhance_audio_quality=True` デフォルト化 | 推論コスト増・遅延増リスク。クローン作成 API のオプションとしてのみ提供 |
| WebSocket 直接実装（B-1 方針B）を Phase B に入れる | HTTP chunk が目標を達成できない場合の次フェーズ候補 |
