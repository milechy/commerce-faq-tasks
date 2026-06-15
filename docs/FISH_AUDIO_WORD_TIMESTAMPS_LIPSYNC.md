# Fish Audio ワードタイムスタンプ → アバターリップシンク精度向上 設計ドキュメント

> 作成日: 2026-06-15
> Asana GID: 1215698617426707
> 前提: PR #410 (Web Speech API → Fish Audio ASR 置換) 実装済み、`FISH_AUDIO_UPGRADE_PROPOSAL.md` Phase B-1 (HTTP ストリーミング) 実装済み

---

## 1. 現状ギャップ分析

### 1.1 現在のリップシンク動作

Lemonslice アバターのリップシンクは **音声波形のエネルギー分析**によって自動駆動される。  
Fish Audio TTS から流れ込む MP3 チャンクを Lemonslice SDK が独自に解析し、口の開閉アニメーションを推定する。

```
[Fish Audio TTS] → MP3 chunks → [LiveKit Agents / Lemonslice SDK]
                                         ↓
                               (内部波形エネルギー分析)
                                         ↓
                               口パクアニメーション
```

**問題**:
- 波形エネルギー分析は「音が出ているか」しか見ない → 音節・単語の境界が口の動きに反映されない
- 日本語の「あいうえお」各母音ごとの口形(viseme)制御が不可能
- MP3 エンコードのフレーム境界と実際の発話タイミングにズレが生じやすい

### 1.2 Fish Audio ASR タイムスタンプの現状

`src/api/avatar/fishAsrRoutes.ts:55` で `ignore_timestamps: 'true'` を明示的に設定しており、  
ASR が返せるワードタイムスタンプを意図的に捨てている。これはユーザー発話側の API。

TTS 側（`avatar-agent/agent.py:319`）では `return_timestamps` パラメータを送っていない。

---

## 2. Fish Audio ワードタイムスタンプ API

### 2.1 TTS エンドポイントのタイムスタンプ対応

Fish Audio `/v1/tts` は `return_timestamps: true` を指定するとレスポンス形式が変わる:

```
POST https://api.fish.audio/v1/tts
Content-Type: application/json

{
  "text": "こんにちは、いらっしゃいませ。",
  "model": "s2-pro",
  "format": "mp3",
  "normalize": true,
  "latency": "balanced",
  "return_timestamps": true     ← 追加
}
```

**レスポンス (multipart/mixed)**:

```
Content-Type: multipart/mixed; boundary=----FishAudioBoundary

------FishAudioBoundary
Content-Type: application/json

{
  "words": [
    { "word": "こんにちは", "start": 0.12, "end": 0.68 },
    { "word": "いらっしゃいませ", "start": 0.72, "end": 1.54 },
    { "word": "。",  "start": 1.54, "end": 1.58 }
  ],
  "duration": 1.60
}

------FishAudioBoundary
Content-Type: audio/mpeg

<MP3 binary...>
```

### 2.2 ASR タイムスタンプ（副次利用）

`/v1/asr` エンドポイントは `ignore_timestamps: false`（デフォルト）で以下を返す:

```json
{
  "text": "音質を確認したい",
  "words": [
    { "word": "音質を",     "start": 0.04, "end": 0.36 },
    { "word": "確認したい", "start": 0.40, "end": 0.84 }
  ]
}
```

ASR タイムスタンプはユーザー発話の「聞き取りアニメーション」（うなずき・耳を傾けるモーション）に活用できる（本 Phase では TTS 側を優先）。

---

## 3. アーキテクチャ設計

### 3.1 タイムスタンプ付き TTS フロー

```
avatar-agent/agent.py
  FishAudioChunkedStream._run()
        │
        ├─ POST /v1/tts with return_timestamps=true
        │
        ├─ multipart レスポンスをパース
        │   ├─ JSON part → word_timestamps: list[WordTimestamp]
        │   └─ audio/mpeg part → MP3 chunks → output_emitter.push()
        │
        └─ asyncio.create_task(_schedule_viseme_cues(word_timestamps))
                │
                └─ 各単語の start 時刻に合わせて
                   control_lemonslice("viseme", phoneme=..., intensity=0.8) を発火
```

### 3.2 Viseme スケジューラ

```python
JAPANESE_VISEME_MAP = {
    # 母音ベースのシンプルマッピング（日本語は母音が支配的）
    "あ": "aa", "か": "aa", "さ": "aa", "た": "aa", "な": "aa",
    "い": "ih", "き": "ih", "し": "ih", "ち": "ih", "に": "ih",
    "う": "ou", "く": "ou", "す": "ou", "つ": "ou", "ぬ": "ou",
    "え": "eh", "け": "eh", "せ": "eh", "て": "eh", "ね": "eh",
    "お": "oh", "こ": "oh", "そ": "oh", "と": "oh", "の": "oh",
    # 子音が強い音
    "ま": "mb", "は": "open", "ら": "fv",
}

async def _schedule_viseme_cues(
    word_timestamps: list[dict],
    audio_start_monotonic: float,
) -> None:
    for wt in word_timestamps:
        word = wt["word"]
        fire_at = audio_start_monotonic + wt["start"]
        now = asyncio.get_event_loop().time()
        delay = max(0.0, fire_at - now)
        await asyncio.sleep(delay)
        # 単語先頭1文字で代表母音を推定（簡易版 / Phase 2 で全文字スキャンに拡張）
        viseme = JAPANESE_VISEME_MAP.get(word[0], "open") if word else "closed"
        await control_lemonslice("viseme", phoneme=viseme, intensity=0.8)
        # 単語終端に口を閉じる
        word_duration = wt["end"] - wt["start"]
        await asyncio.sleep(word_duration * 0.85)
        await control_lemonslice("viseme", phoneme="closed", intensity=0.5)
```

### 3.3 Lemonslice Control API — viseme イベント

Lemonslice の Control API（`/api/liveai/sessions/{session_id}/control`）は `viseme` イベントを受け付ける:

```json
{
  "event": "viseme",
  "phoneme": "aa",      // ARPAbet または独自コード
  "intensity": 0.8      // 0.0〜1.0
}
```

**確認事項（実装前に Lemonslice サポートに問い合わせ or API ドキュメント照合）**:
- [ ] `viseme` イベント名が正しいか（`phoneme`, `mouth_shape` など別名の可能性）
- [ ] `intensity` パラメータのサポート有無
- [ ] 対応 phoneme コードの一覧（ARPAbet vs 独自）
- [ ] Fire-and-forget で安全か、順序保証が必要か

---

## 4. multipart パーサー実装方針

Fish Audio の multipart レスポンスをストリーミングで処理するため、既存の `aiohttp` を使った段階的パース:

```python
async def _parse_timestamps_multipart(
    resp: aiohttp.ClientResponse,
) -> tuple[list[dict], asyncio.Queue]:
    """
    Returns:
        word_timestamps: 完全な JSON を受け取り次第返す（音声より先に届く）
        audio_queue: MP3 チャンクを流す asyncio.Queue（None で終端）
    """
    boundary = _extract_boundary(resp.content_type)  # boundary= を取り出す
    audio_queue: asyncio.Queue = asyncio.Queue()
    word_timestamps: list[dict] = []

    async def _reader():
        buffer = b""
        in_audio = False
        async for chunk in resp.content.iter_chunked(4096):
            buffer += chunk
            # JSON part の終端を検出してパース
            if not word_timestamps and b'"words"' in buffer:
                json_end = buffer.find(b"\r\n--" + boundary.encode())
                if json_end != -1:
                    json_bytes = buffer[:json_end].lstrip(b"\r\n")
                    data = json.loads(json_bytes)
                    word_timestamps.extend(data.get("words", []))
                    buffer = buffer[json_end:]
                    in_audio = True
            if in_audio:
                audio_chunk = _strip_boundary_header(buffer, boundary)
                if audio_chunk:
                    await audio_queue.put(audio_chunk)
                    buffer = b""
        await audio_queue.put(None)  # 終端

    asyncio.create_task(_reader())
    return word_timestamps, audio_queue
```

> **注意**: Fish Audio の multipart 境界仕様は公式 OpenAPI ドキュメント (`https://api.fish.audio/openapi.json`) で確認してから実装すること。仕様が異なる場合は `WebSocket` ストリーミング API に切り替える（後述 Phase 2）。

---

## 5. 実装フェーズ

### Phase 1 — 単語粒度リップシンク（推定 2〜3 日）

**変更ファイル**: `avatar-agent/agent.py` のみ

| 変更内容 | 概要 |
|---------|------|
| `FishAudioChunkedStream._run()` | `return_timestamps: true` 追加、multipart レスポンスをパース |
| `_schedule_viseme_cues()` 追加 | asyncio タスクで viseme イベントを時刻スケジューリング |
| `JAPANESE_VISEME_MAP` 定数 | 単語先頭文字 → viseme コードのマッピング |
| `control_lemonslice` 呼び出し | 既存関数を流用（変更不要） |

**フォールバック**: Lemonslice が `viseme` イベントを拒否した場合（`resp.status != 200`）は警告のみ出してサイレント継続（現在の波形ベース動作に退縮）。

**Gate 通過要件**:
- Gate 1: `pnpm verify` — TypeScript 変更なし (`agent.py` のみ)
- Gate 2: `bash SCRIPTS/security-scan.sh` — API キーログ混入なし
- Gate 3: `pnpm build` — Python ファイルのみ変更で影響なし

---

### Phase 2 — 音素粒度 + WebSocket ストリーミング（推定 4〜5 日）

Phase 1 で Lemonslice viseme API の動作が確認できてから着手。

**追加改善**:
- 単語内全文字のスキャン（先頭1文字のみ → 全音節を逐次発火）
- Fish Audio WebSocket API (`wss://api.fish.audio/v1/tts/ws`) でリアルタイム timestamp ストリーミング
- `fish-audio-sdk` の `AsyncSession.tts()` を活用（現在は未使用 — `FISH_AUDIO_UPGRADE_PROPOSAL.md` §1.1 参照）

**期待効果**: TTFA 短縮 + 音素単位の viseme 制御 → 映像と音声のズレ ±50ms 以内

---

### Phase 3 — ユーザー発話聞き取りアニメーション（推定 1〜2 日）

`fishAsrRoutes.ts` の `ignore_timestamps: 'true'` を削除し、ASR 結果の word timestamps を widget.js 経由で DataChannel に送信。アバターが「聞き取り中」のリアルタイムうなずきモーションを実行。

---

## 6. リスク・依存関係マトリクス

| リスク | 影響度 | 対応 |
|--------|--------|------|
| `return_timestamps: true` が Fish Audio S2-Pro で未サポート | 高 | `openapi.json` で事前確認。未サポートなら WebSocket API（Phase 2）に先行する |
| Lemonslice が `viseme` イベントを未サポート | 高 | Lemonslice ドキュメント / サポートで事前確認。未サポートなら `blend_shapes` 等の代替イベント調査 |
| multipart レスポンスのパーサーバグでデッドロック | 中 | `asyncio.Queue` に `maxsize=128` を設定し、`asyncio.wait_for` で 5秒タイムアウトを設ける |
| viseme イベントのレート制限（Lemonslice API） | 中 | 単語単位（〜20 回/発話）で発火。100 ワード/秒は超えない |
| 日本語 viseme マッピング精度 | 低 | Phase 1 は先頭文字で充分。精度指摘があれば kakasi ライブラリでの読み仮名変換に移行（Phase 2） |

---

## 7. 実装前チェックリスト

```bash
# 1. Fish Audio が return_timestamps をサポートしているか確認
curl -s https://api.fish.audio/openapi.json | python3 -c "
import json, sys
spec = json.load(sys.stdin)
body = spec.get('paths', {}).get('/v1/tts', {}).get('post', {})
print(json.dumps(body.get('requestBody', {}), indent=2, ensure_ascii=False))
" | grep -i timestamp

# 2. 実際のレスポンスで確認（短いテキストで）
curl -X POST https://api.fish.audio/v1/tts \
  -H "Authorization: Bearer $FISH_AUDIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"こんにちは","model":"s2-pro","format":"mp3","return_timestamps":true}' \
  -D - -o /dev/null 2>&1 | head -20

# 3. Lemonslice viseme API の確認（Lemonslice サポートに問い合わせ or 実機テスト）
# 以下は仮コマンド（session_id を実際の値に置き換え）
curl -X POST "https://lemonslice.com/api/liveai/sessions/${SESSION_ID}/control" \
  -H "X-API-Key: $LEMONSLICE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"event":"viseme","phoneme":"aa","intensity":0.8}' \
  -w "\nHTTP %{http_code}\n"
```

---

## 8. 既存実装との依存関係

| 既存実装 | 本タスクとの関係 |
|---------|----------------|
| `FISH_AUDIO_UPGRADE_PROPOSAL.md` Phase A (S2-Pro 明示指定) | 本タスクも `"model": "s2-pro"` を前提。Phase A 完了が先行必須 |
| `FISH_AUDIO_UPGRADE_PROPOSAL.md` Phase B-1 (HTTP ストリーミング) | `return_timestamps: true` を追加する実装は Phase B-1 の `_run()` メソッドに重ねる |
| `docs/AVATAR_SALESFLOW_EMOTION_TAGS.md` (感情タグ) | SalesFlow の感情タグ注入（`[empathetic]` 等）と viseme スケジューリングは独立して動作。同一 `synthesize()` 呼び出し内で共存可能 |
| PR #410 Fish Audio ASR (`fishAsrRoutes.ts`) | Phase 3 でのみ使用。Phase 1 は TTS 側のみ変更 |
| `control_lemonslice()` 関数 (`agent.py:78`) | 変更不要。`viseme` イベント名を追加するだけで流用可能 |

---

## 9. 期待効果

| 指標 | 現状 | Phase 1 後 | Phase 2 後 |
|------|------|-----------|-----------|
| 口パク同期精度 | 波形エネルギー（単語境界無視） | 単語先頭で viseme 発火（±100ms） | 音素単位（±50ms） |
| 対応言語 | 音声波形依存（言語非依存） | 日本語母音5形 | 日本語全音節 + kakasi 読み |
| Lemonslice API 呼び出し回数 | 0 回/発話 | 〜2×(単語数)/発話 | 〜2×(音節数)/発話 |
| フォールバック | — | viseme 拒否時→波形ベースに退縮 | Phase 1 フォールバック引き継ぎ |
