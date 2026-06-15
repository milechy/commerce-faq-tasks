# LiveKit アップグレード実装提案書

**作成日**: 2026-06-10  
**対象ブランチ**: `fix/avatar-startup-speed`（または後継 feature ブランチ）  
**優先度区分**: P0（即時）/ P1（次スプリント）/ P2（検討）

---

## 0. 現状サマリーと問題点

| コンポーネント | 現在バージョン | 最新バージョン | 遅れ |
|---|---|---|---|
| `livekit-agents` (Python, avatar-agent) | **1.5.5** | 1.5.17 | 12リリース |
| `livekit-client` (JS, public/widget.js) | **2.9.1** | 2.19.2 | 10リリース |
| `livekit-server-sdk` (Node.js, token route) | `^2.15.0` | 2.15.4 | 範囲内 |

### 現在観測されている問題（アップグレードで解消が期待できるもの）
- アバター起動時に音声バインドタイミングがズレる（#5837 で修正済み）
- 長時間セッションで Widget のメモリリーク（#1944/#1896 で修正済み）
- 複数センテンス TTS の間に不要フレームドロップが発生（#5815 で修正済み）

---

## 1. P0: バージョンアップ（リスク低・効果大）

### 1-A. livekit-agents 1.5.5 → 1.5.17

**対象ファイル**: `avatar-agent/requirements.txt`

```diff
-livekit-agents[lemonslice,openai]==1.5.5
+livekit-agents[lemonslice,openai]==1.5.17
```

**自動で得られる改善**（コード変更不要）:
- `#5837` LemonSlice: HTTP呼び出し前にアバター音声出力をバインド → 起動時の音声タイミング修正
- `#5815` フレームドロップ→サイレンスフレームに置換 → TTS間の音声途切れ軽減
- `#5874` IPC spawn 失敗時のリトライ → VPS での安定性向上
- `#5824` ChatMessage.interrupted の proto シリアライズ修正
- `#5846` ToolError の LLM への返却改善（ArgValidation）
- `#5861` Field() アノテーション保持（function tool 引数）

**影響範囲**:
- `avatar-agent/agent.py`: lemonslice・openai プラグイン使用 → 互換性確認必須
- VPS の pip 環境: 再インストールが必要（`pip install -r requirements.txt`）
- FishAudioTTS カスタムクラス: `agents_tts.TTS` / `ChunkedStream` 継承 → 1.5.x で API 変更なし（確認済み範囲）

**確認事項**:
- [ ] `livekit-agents[lemonslice,openai]==1.5.17` が lemonslice プラグイン含むか PyPI で確認
- [ ] FishAudioTTS の `TTSCapabilities` / `AudioEmitter` API が 1.5.17 で変更されていないか changelog 確認
- [ ] VPS で `pip install -r requirements.txt` → avatar-agent 起動テスト

---

### 1-B. livekit-client 2.9.1 → 2.19.2

**対象ファイル**: `public/widget.js` (line 1031)

```diff
-var LIVEKIT_SDK_URL = 'https://cdn.jsdelivr.net/npm/livekit-client@2.9.1/dist/livekit-client.umd.min.js';
+var LIVEKIT_SDK_URL = 'https://cdn.jsdelivr.net/npm/livekit-client@2.19.2/dist/livekit-client.umd.min.js';
```

**自動で得られる改善**:
- `#1944` `devicechange` リスナーのメモリリーク修正（長時間セッションに効く）
- `#1896` `waitForBufferStatusLow` のイベントリスナー蓄積修正
- `#1954` Firefox: publisher offer 最適化（モバイルブラウザ互換性向上）
- `#1963` Firefox: v1 シグナリングで初期 media sections 送信
- `#1893` transport manager reset（legacy fallback 前）
- `#1900` 更新トークンの regionUrlProvider への確実な設定

**影響範囲**:
- widget.js 内の Room 初期化: `new LK.Room({ adaptiveStream: true, dynacast: true })`
  - 2.9.1 → 2.19.2 間で Room コンストラクタの options schema に破壊的変更なし（minor リリース）
- RoomEvent ハンドラ（DataReceived / TrackSubscribed / Disconnected / Reconnecting / Reconnected）: 変更なし
- `room.localParticipant.publishData()`: API 変更なし

**確認事項**:
- [ ] `livekit-client@2.19.2` の UMD ビルドが jsdelivr に存在するか確認
- [ ] `LK.Room` / `LK.RoomEvent` / `LK.Track.Kind.Audio` などの名前が 2.19.2 で同一か確認
- [ ] Playwright e2e でアバター接続フロー通過確認（`tests/e2e/phase65-demo.spec.ts`）
- [ ] `src/lib/headers.csp.ts` の `script-src` に `cdn.jsdelivr.net` が含まれるか確認

---

## 2. P1: コード改善（agent.py の新 API 活用）

### 2-A. wait_for_join ヘルパーの活用（#5836）

**概要**: アバター参加者の Room 参加を確実に待機。現在は `avatar.start()` 後すぐ `session.start()` を呼んでいるが、LemonSlice の join 前に session が始まる可能性がある。

**現在のコード** (`agent.py` lines 471-482):
```python
avatar = lemonslice.AvatarSession(**avatar_kwargs)
await avatar.start(session, room=ctx.room)
logger.info("=== LEMONSLICE AVATAR STARTED ===")

await session.start(
    room=ctx.room,
    agent=Agent(instructions=effective_system_prompt),
)
```

**変更案**:
```python
avatar = lemonslice.AvatarSession(**avatar_kwargs)
await avatar.start(session, room=ctx.room)
logger.info("=== LEMONSLICE AVATAR STARTED ===")

# 1.5.17新API: avatarがroomにjoinするまで最大10秒待機
# これがないとsession.start()がavatarの準備前に音声送信を開始する可能性がある
try:
    await avatar.wait_for_join(timeout=10.0)
    logger.info("=== AVATAR PARTICIPANT JOINED ROOM ===")
except Exception as e:
    logger.warning(f"[avatar] wait_for_join timeout (continuing): {e}")

await session.start(
    room=ctx.room,
    agent=Agent(instructions=effective_system_prompt),
)
```

**影響範囲**:
- `entrypoint()` 内のアバター起動シーケンスのみ
- タイムアウト時は except で続行するため既存動作にフォールバック

**確認事項**:
- [ ] `lemonslice.AvatarSession.wait_for_join()` の存在と引数シグネチャを `pip install` 後に確認
- [ ] タイムアウト値（10秒）が LemonSlice の join 所要時間と整合するか実測

---

### 2-B. aclose 時のアバターキック（#5836）

**概要**: セッション終了時にアバター参加者を Room から明示的に退出させる。現在は明示的な cleanup なし → LemonSlice Cloud 側でゾンビ参加者が残り続けるリスクがある。

**変更案** (`entrypoint()` 末尾):
```python
await session.start(
    room=ctx.room,
    agent=Agent(instructions=effective_system_prompt),
)
logger.info("=== SESSION STARTED ===")

# セッション終了まで待機
try:
    await session.wait_for_shutdown()
except Exception as e:
    logger.warning(f"[session] shutdown error: {e}")
finally:
    # 1.5.17: aclose時にアバター参加者をkick（孤立防止）
    try:
        await avatar.aclose()
        logger.info("[avatar] aclose completed")
    except Exception as e:
        logger.warning(f"[avatar] aclose error: {e}")
```

**影響範囲**:
- `entrypoint()` 末尾のみ
- `avatar.aclose()` 例外は finally 内なので session 終了には影響なし

**確認事項**:
- [ ] `AgentSession.wait_for_shutdown()` API の存在確認（または等価の待機方法）
- [ ] LemonSlice Cloud の参加者数課金に影響するか確認（ゾンビ対策の優先度判断）

---

### 2-C. バックグラウンド音声フェード（#5832）

**概要**: `AgentSession` の `AudioConfig` で音声開始・終了をフェードイン/アウトし、TTS 開始の唐突感を排除。

**変更案**（`agent.py` の `AgentSession` 初期化）:
```python
from livekit.agents import AudioConfig  # 1.5.17で追加

session = AgentSession(
    llm=groq_llm,
    tts=fish_tts,
    user_away_timeout=None,
    # 1.5.17新API: フェードイン/アウト設定
    audio_config=AudioConfig(
        fade_in=0.1,   # 秒: 音声開始時（FishAudio MP3デコード遅延を考慮して0.1s）
        fade_out=0.1,  # 秒: 音声終了時
    ),
)
```

**影響範囲**:
- `AgentSession` 初期化部分のみ
- FishAudioTTS のサンプルレート（44100Hz）との互換性要確認

**確認事項**:
- [ ] `AudioConfig` クラスが `livekit-agents==1.5.17` に存在するか確認
- [ ] fade_in 値が FishAudio の MP3 デコード遅延（~100-200ms）と競合しないか確認
- [ ] `agent.py` の既存コードで `AudioConfig` が既にインポートされていないか確認（重複防止）

---

## 3. P1: widget.js の新機能追加

### 3-A. ノイズキャンセレーション（LiveKit Blog 2026-06-10）

**概要**: Room 初期化時に `audioCaptureDefaults` を設定し、マイク入力の音声品質を向上。

**現在のコード** (widget.js line 1553):
```javascript
var room = new LK.Room({ adaptiveStream: true, dynacast: true });
```

**変更案**:
```javascript
var room = new LK.Room({
  adaptiveStream: true,
  dynacast: true,
  // 2.19.2: ノイズキャンセレーション（マイク入力時に適用）
  audioCaptureDefaults: {
    noiseSuppression: true,
    echoCancellation: true,
    autoGainControl: true,
  },
});
```

**影響範囲**:
- widget.js の Room 初期化のみ（1行変更）
- アバターの音声受信（TrackSubscribed）には影響なし
- mic-btn でマイク入力を有効化した場合にのみ適用される

**確認事項**:
- [ ] livekit-client 2.19.2 の `RoomOptions` 型定義で `audioCaptureDefaults` が存在するか確認
- [ ] エコーキャンセレーションが LemonSlice 音声ループ（スピーカー→マイク）を防ぐか Playwright で確認
- [ ] ブラウザネイティブの MediaTrackConstraints と重複しないか確認

---

### 3-B. publishData の Promise 化対応（#1892 関連）

**概要**: livekit-client 2.19.2 では `publishData()` が Promise を返す。現在のコードは戻り値を無視しているため、送信失敗が無音で消える。

**現在のコード** (`sendTTSRequest()` 内):
```javascript
room.localParticipant.publishData(payload, { reliable: true });
```

**変更案**:
```javascript
var sendPromise = room.localParticipant.publishData(payload, { reliable: true });
if (sendPromise && typeof sendPromise.catch === 'function') {
  sendPromise.catch(function(e) {
    console.warn('[FAQ Widget] publishData error:', e);
  });
}
```

**影響範囲**:
- `sendTTSRequest()` 関数のみ（widget.js）
- `reliable: true` は既に設定済みなので動作変更なし、エラー可視化のみ

**確認事項**:
- [ ] 2.19.2 で `publishData()` が Promise を返すことを型定義で確認
- [ ] 2.9.1 では void 戻り値だったため、Promise 判定の `if (sendPromise)` ガードが必要

---

## 4. P2: 新機能追加（検討段階）

### 4-A. Agent Console の有効化

**概要**: LiveKit のリアルタイムエージェントデバッグダッシュボード。コード変更不要、LiveKit Cloud の Settings から有効化。

**R2C での活用**:
- アバター起動の遅延箇所（Room 参加 / Agent Dispatch / LemonSlice join）をビジュアル確認
- TTS パイプラインのレイテンシ計測
- 本番インシデント時の状態確認

**確認事項**:
- [ ] LiveKit Cloud の契約プランで Agent Console が使用可能か確認
- [ ] 本番テナントデータが Agent Console に表示される範囲のプライバシー確認

---

### 4-B. claim_user_turn による会話フロー制御（#5806/#5911）

**概要**: `AgentSession.claim_user_turn()` でエージェントが会話ターンを明示的に取得。`tts_request` と `chat` が同時に到着した場合の TTS 重複発話を防止。

**変更案** (`handle_tts_request()` 内):
```python
async def handle_tts_request(reply_text: str) -> None:
    try:
        await session.claim_user_turn()  # 1.5.17新API
        session.say(reply_text)
    except Exception as e:
        logger.error(f"[handle_tts_request] error: {e}")
```

**確認事項**:
- [ ] `claim_user_turn()` が 1.5.17 のパブリック API か確認
- [ ] 現在の実装で TTS 重複が実際に発生しているか確認（事前に問題があるか検証してから適用）
- [ ] `asyncio.create_task()` との組み合わせで `await` が正しく機能するか確認

---

### 4-C. Groq → Gemini 移行時のコンテキストキャッシュ（#5675）

**概要**: Google AI Platform 移行時に `cached_content` オプションでシステムプロンプトをキャッシュ → レイテンシ削減。現在は Groq 継続のため P2。Groq 移行検討時に再評価。

---

## 5. 実装順序とゲート要件

```
Phase 1: バージョンバンプ（P0 — 1-A + 1-B）
  ├── avatar-agent/requirements.txt: 1.5.5 → 1.5.17
  ├── public/widget.js: CDN URL @2.9.1 → @2.19.2
  ├── Gate 1: pnpm verify（typecheck + lint + test 全パス）
  ├── Gate 2: bash SCRIPTS/security-scan.sh（CDN URL 変更による CSP 影響確認）
  ├── Gate 3: pnpm build
  ├── Gate 2.5: /codex:review --base main（スキップ可否: CSS/ドキュメントのみではないため実行推奨）
  └── VPS: pip install -r requirements.txt → pm2 restart avatar-agent

Phase 2: agent.py 改善（P1 — 2-A + 2-B + 2-C）
  ├── wait_for_join + aclose cleanup（2-A + 2-B）
  ├── AudioConfig fade_in/fade_out（2-C）
  ├── Gate 1: pnpm verify
  └── Playwright e2e: アバター起動から TTS まで一気通貫テスト

Phase 3: widget.js 改善（P1 — 3-A + 3-B）
  ├── audioCaptureDefaults ノイズキャンセル（3-A）
  ├── publishData Promise エラーハンドリング（3-B）
  ├── Gate 1: pnpm verify
  └── Playwright e2e: マイク入力 + TTS 受信テスト（390px viewport）
```

---

## 6. 影響する既存機能マトリクス

| 機能 | ファイル | 影響レベル | 備考 |
|---|---|---|---|
| アバター起動（`fix/avatar-startup-speed`） | `avatar-agent/agent.py` | **高** | 1.5.17 の LemonSlice fix が目的と直結 |
| Widget テキストチャット | `public/widget.js` | 低 | JS SDK 更新のみ、チャット動作変更なし |
| Widget マイク入力 | `public/widget.js` | 中 | audioCaptureDefaults で音質向上 |
| LiveKit Token Route | `src/api/avatar/livekitTokenRoutes.ts` | なし | server-sdk は^2.15.0範囲内で自動更新 |
| CSP ヘッダー | `src/lib/headers.csp.ts` | **要確認** | jsdelivr が script-src に含まれるか確認 |
| Playwright e2e | `tests/e2e/phase65-demo.spec.ts` | **要テスト** | アバター起動シーケンス変更後に確認 |
| FishAudio TTS クラス | `avatar-agent/agent.py` | **要確認** | `ChunkedStream` / `AudioEmitter` API 互換性 |
| Phase48 LLM Defense | `src/middleware/` | なし | ノイズキャンセルは独立レイヤー |

---

## 7. リスク評価

| リスク | 確率 | 影響 | 対策 |
|---|---|---|---|
| lemonslice プラグイン API 変更（1.5.5→1.5.17） | 低 | 高 | `pip install` 後に `dir(lemonslice.AvatarSession)` で確認 |
| FishAudioTTS の `ChunkedStream` API 変更 | 低 | 高 | 1.5.17 changelog で `tts.ChunkedStream` 変更有無確認 |
| widget.js CDN URL 変更でロード失敗 | 低 | 高 | `curl -I` で @2.19.2 存在事前確認 |
| audioCaptureDefaults が Firefox でクラッシュ | 中 | 中 | Firefox e2e テスト追加 |
| wait_for_join タイムアウトで起動遅延 | 中 | 中 | timeout 値を調整、失敗時は continue でフォールバック |
| AudioConfig の fade 値で TTS 先頭が切れる | 中 | 低 | 0.1s から始め、実測で調整 |
| Agent Console で本番テナントデータ露出 | 低 | 高 | 本番環境では無効、開発環境のみ |

---

## 8. 不適用項目（R2C スコープ外）

| 機能 | 理由 |
|---|---|
| AMD（Answering Machine Detection） | 電話アウトバウンド非使用 |
| Respeecher / Inworld / Smallestai TTS | FishAudio TTS 固定 |
| GnaniAI / Cartesia / Gradium STT | STT 未使用（data channel で text 受信） |
| Google AI Platform LLM | Groq 継続 |
| MongoDB Vector Search 連携 | PostgreSQL pgvector 使用 |
| MCP `mcp_servers` deprecate 対応 | MCP 未使用 |
| Voicemail / IVR 検知 | アウトバウンドコール非使用 |
| C++ SDK | Python/JS 実装 |

---

## 9. 実装前の必須確認アクション

### Phase 1（バージョンバンプ）実施前
```bash
# 1. PyPI でバージョン存在確認
pip index versions livekit-agents 2>&1 | grep "1.5.17"

# 2. CDN で 2.19.2 の UMD ビルド存在確認
curl -sI "https://cdn.jsdelivr.net/npm/livekit-client@2.19.2/dist/livekit-client.umd.min.js" | grep "HTTP"

# 3. CSP ヘッダーに jsdelivr が含まれるか確認
grep -n "jsdelivr\|cdn\|script-src" src/lib/headers.csp.ts src/lib/headers.csp.test.ts
```

### Phase 2（agent.py 改善）実施前
```bash
# ローカル venv or VPS で
pip install "livekit-agents[lemonslice,openai]==1.5.17"
python -c "from livekit.plugins import lemonslice; print([m for m in dir(lemonslice.AvatarSession) if 'join' in m or 'close' in m])"
python -c "from livekit.agents import AudioConfig; print(AudioConfig.__init__.__doc__)"
```

### Phase 3（widget.js 改善）実施前
```bash
# 型定義で audioCaptureDefaults の存在確認
curl -s "https://cdn.jsdelivr.net/npm/livekit-client@2.19.2/dist/livekit-client.d.ts" | grep -A5 "audioCaptureDefaults"
# または npm でローカル確認
cd /tmp && npm pack livekit-client@2.19.2 && tar xf livekit-client-2.19.2.tgz && grep -r "audioCaptureDefaults" package/
```

---

*この提案書は 2026-06-10 の LiveKit GitHub リリースノート・公式ブログ調査に基づく。  
実装前に各「確認事項」を実機照合すること（memory・anatomy.md 記載情報は古い可能性あり）。*
