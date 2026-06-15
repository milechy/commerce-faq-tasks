"""
RAJIUCE Avatar Agent
Groq LLM + Lemonslice Self-Managed Avatar orchestration via LiveKit Agents v1.4+.

NOTE: Silero VAD は除外（VPS に GPU/CUDA/libva-drm がないため SIGABRT でクラッシュ）。
"""

# ─── dotenv を全 import の前にロード ──────────────────────────────────────────
import os
from pathlib import Path
from dotenv import load_dotenv

# avatar-agent/.env を優先、なければ親ディレクトリの .env
_here = Path(__file__).resolve().parent
for _candidate in [_here / ".env", _here.parent / ".env"]:
    if _candidate.exists():
        load_dotenv(dotenv_path=_candidate, override=True)
        break

os.environ.setdefault("LIBVA_DRIVER_NAME", "dummy")

# ─── 通常の import ────────────────────────────────────────────────────────────
import asyncio
import json
import logging
import math
import time
import aiohttp
from livekit import agents, rtc
from livekit.agents import Agent, AgentSession
from livekit.agents import tts as agents_tts
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, APIConnectOptions
from livekit.plugins import lemonslice
from livekit.plugins import openai as openai_plugin
from emotion_tags import sales_flow_emotion_prefix

logger = logging.getLogger("rajiuce-avatar")
logger.setLevel(logging.INFO)

logger.info(f"[module] LIVEKIT_URL={os.environ.get('LIVEKIT_URL', 'NOT SET')}")
logger.info(f"[module] LIVEKIT_API_KEY={'SET' if os.environ.get('LIVEKIT_API_KEY') else 'NOT SET'}")
logger.info(f"[module] LEMONSLICE_API_KEY={'SET' if os.environ.get('LEMONSLICE_API_KEY') else 'NOT SET'}")

# --- 定数 ---
FALLBACK_MSG = "申し訳ございません。もう一度お尋ねください。"

SYSTEM_PROMPT = (
    "あなたはカーネーション自動車（BROSS新潟）のAI営業アシスタントです。\n"
    "以下のルールに従って、お客様に日本語で応答してください。\n\n"
    "【回答ルール】\n"
    "- 必ず1〜2文の短い日本語で回答してください。\n"
    "- 知っている情報は積極的に答えてください。「店長に相談」は最終手段です。\n"
    "- 具体的な在庫状況・値引き額・ローン審査結果は不明なので、その場合のみ来店を案内してください。\n\n"
    "【店舗情報】\n"
    "- 店名: カーネーション自動車（BROSS新潟）\n"
    "- 営業時間: 平日・土曜 9:00〜18:00、日曜・祝日 定休日\n"
    "- 取扱メーカー: トヨタ、日産、ホンダ、マツダ等の中古車全般\n"
    "- 特徴: 全車両整備済み・保証付き、ファイナンス相談可能\n"
)

# --- LemonSlice I-4: In-Call Dynamic Update ---
# avatar.start() の戻り値（LemonSlice session_id）を保持。Control API 呼び出しに使用。
_lemonslice_session_id: str | None = None

# フロー状態 → 表情・動作プロンプトのマッピング（Phase22 State Machine + SalesFlow 互換）
STATE_AGENT_PROMPTS = {
    "clarify": "attentive and curious, leaning in slightly",
    "answer": "confident and helpful",
    "confirm": "enthusiastic and persuasive",
    "terminal": "warm and appreciative, gentle bow",
    # SalesFlow（/api/chat パスの salesContextStore currentStage 由来）
    "propose": "enthusiastic and persuasive",
    "recommend": "confident and persuasive, presenting options",
    "close": "joyful and celebratory",
}


async def control_lemonslice(event: str, **kwargs) -> bool:
    """LemonSlice Control API への fire-and-forget ラッパー（失敗は warning のみ・non-fatal）。

    注意: session_id / API キーはログに出さないこと。
    """
    if not _lemonslice_session_id:
        logger.debug("[lemonslice-control] session_id not available, skipping")
        return False
    api_key = os.environ.get("LEMONSLICE_API_KEY")
    if not api_key:
        logger.warning("[lemonslice-control] LEMONSLICE_API_KEY not set, skipping")
        return False
    try:
        async with aiohttp.ClientSession() as http:
            async with http.post(
                f"https://lemonslice.com/api/liveai/sessions/{_lemonslice_session_id}/control",
                headers={"X-API-Key": api_key, "Content-Type": "application/json"},
                json={"event": event, **kwargs},
                timeout=aiohttp.ClientTimeout(total=3),
            ) as resp:
                ok = resp.status == 200
                if not ok:
                    logger.warning(f"[lemonslice-control] {event} → {resp.status}")
                return ok
    except Exception as e:
        logger.warning(f"[lemonslice-control] {event} error (non-fatal): {e}")
        return False


# --- Groq LLM 直接呼び出し ---
async def fetch_avatar_config(tenant_id: str, api_url: str, avatar_config_id: str | None = None) -> dict | None:
    """テナント別アバター設定を内部APIから取得。失敗時はNoneを返す。
    avatar_config_id 指定時は特定アバターを取得（テスト用途）。
    """
    params: dict[str, str] = {"tenantId": tenant_id}
    if avatar_config_id:
        params["avatarConfigId"] = avatar_config_id
    try:
        async with aiohttp.ClientSession() as http:
            async with http.get(
                f"{api_url}/api/internal/avatar-config",
                params=params,
                headers={"X-Internal-Request": "1"},
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                if resp.status != 200:
                    logger.warning(f"[avatar-config] API returned {resp.status}")
                    return None
                data = await resp.json()
                return data.get("config")
    except Exception as e:
        logger.warning(f"[avatar-config] fetch failed (using defaults): {e}")
        return None


async def call_groq_llm(
    user_text: str,
    http: aiohttp.ClientSession,
    system_prompt: str = SYSTEM_PROMPT,
    tenant_id: str | None = None,
) -> str:
    """Groq LLM を aiohttp で直接呼び出し、応答テキストを返す。"""
    try:
        async with http.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {os.environ['GROQ_API_KEY']}",
                "Content-Type": "application/json",
            },
            json={
                "model": "llama-3.3-70b-versatile",
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_text},
                ],
                "max_tokens": 300,
                "temperature": 0.7,
            },
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            if resp.status != 200:
                logger.error(f"[Groq] error {resp.status}: {await resp.text()}")
                return FALLBACK_MSG
            data = await resp.json()
            content = data["choices"][0]["message"]["content"].strip()
            # Phase53: トークン数を非同期レポート（fire-and-forget）
            usage = data.get("usage", {})
            prompt_tokens = usage.get("prompt_tokens", 0)
            completion_tokens = usage.get("completion_tokens", 0)
            if tenant_id and (prompt_tokens > 0 or completion_tokens > 0):
                asyncio.ensure_future(
                    _report_groq_usage(tenant_id, prompt_tokens, completion_tokens)
                )
            return content
    except Exception as e:
        logger.error(f"[Groq] exception: {e}")
        return FALLBACK_MSG


async def _report_groq_usage(
    tenant_id: str, prompt_tokens: int, completion_tokens: int
) -> None:
    """Avatar内Groqトークン使用量をRAJIUCE APIに非同期レポート（fire-and-forget）。"""
    api_url = os.environ.get("RAJIUCE_API_URL", "http://localhost:3100")
    try:
        async with aiohttp.ClientSession() as http_session:
            await http_session.post(
                f"{api_url}/api/internal/usage",
                headers={"X-Internal-Request": "1", "Content-Type": "application/json"},
                json={
                    "tenantId": tenant_id,
                    "inputTokens": prompt_tokens,
                    "outputTokens": completion_tokens,
                    "model": "llama-3.3-70b-versatile",
                    "featureUsed": "avatar",
                },
                timeout=aiohttp.ClientTimeout(total=5),
            )
        logger.debug(
            f"[usage] Groq token usage reported: tenant={tenant_id} "
            f"prompt={prompt_tokens} completion={completion_tokens}"
        )
    except Exception as e:
        logger.warning(f"[usage] Groq token usage report failed (non-critical): {e}")


# --- Fish Audio TTS ---

async def _report_tts_usage(tenant_id: str, tts_text_bytes: int) -> None:
    """TTS使用量をRAJIUCE APIに非同期レポート（fire-and-forget）。"""
    api_url = os.environ.get("RAJIUCE_API_URL", "http://localhost:3100")
    try:
        async with aiohttp.ClientSession() as http_session:
            await http_session.post(
                f"{api_url}/api/internal/usage",
                headers={"X-Internal-Request": "1", "Content-Type": "application/json"},
                json={"tenantId": tenant_id, "ttsTextBytes": tts_text_bytes},
                timeout=aiohttp.ClientTimeout(total=5),
            )
        logger.debug(f"[usage] TTS usage reported: tenant={tenant_id} bytes={tts_text_bytes}")
    except Exception as e:
        logger.warning(f"[usage] TTS usage report failed (non-critical): {e}")


# LemonSlice は約24.5クレジット/分消費（料金表の割当 1000credit/41min・5400/220・15000/610 から逆算）。
LEMONSLICE_CREDITS_PER_MINUTE = 24.5


async def _report_avatar_usage(tenant_id: str, session_ms: int) -> None:
    """LemonSlice アバターのセッション課金をRAJIUCE APIへ非同期レポート（fire-and-forget）。

    セッション時間（ms）→ 分 → クレジット換算（約24.5credit/分）で avatarCredits を報告する。
    本体側 costCalculator が avatarCredits × $0.007/credit で原価計上する。
    """
    if session_ms <= 0:
        return
    minutes = session_ms / 60000.0
    credits = math.ceil(minutes * LEMONSLICE_CREDITS_PER_MINUTE)
    api_url = os.environ.get("RAJIUCE_API_URL", "http://localhost:3100")
    try:
        async with aiohttp.ClientSession() as http_session:
            await http_session.post(
                f"{api_url}/api/internal/usage",
                headers={"X-Internal-Request": "1", "Content-Type": "application/json"},
                json={"tenantId": tenant_id, "avatarCredits": credits, "avatarSessionMs": session_ms},
                timeout=aiohttp.ClientTimeout(total=5),
            )
        logger.info(
            f"[usage] LemonSlice avatar usage reported: tenant={tenant_id} "
            f"session_ms={session_ms} credits={credits}"
        )
    except Exception as e:
        logger.warning(f"[usage] avatar usage report failed (non-critical): {e}")


class FishAudioTTS(agents_tts.TTS):
    def __init__(
        self,
        api_key: str,
        reference_id: str | None = None,
        tenant_id: str | None = None,
        emotion_tags: list[str] | None = None,
    ):
        super().__init__(
            capabilities=agents_tts.TTSCapabilities(streaming=False),
            sample_rate=44100,
            num_channels=1,
        )
        self._api_key = api_key
        self._reference_id = reference_id
        self._tenant_id = tenant_id
        self._emotion_tags = emotion_tags or []
        logger.info(f"[TTS] FishAudioTTS initialized: ref={self._reference_id} tenant={self._tenant_id} emotion_tags={self._emotion_tags}")

    def synthesize(
        self,
        text: str,
        *,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> "FishAudioChunkedStream":
        # S2-Pro 感情タグ注入: [empathetic][calm] 形式でテキスト先頭に付与（最大3個）
        prefix = "".join(f"[{t}]" for t in self._emotion_tags[:3]) if self._emotion_tags else ""
        return FishAudioChunkedStream(
            tts=self,
            input_text=prefix + text,
            conn_options=conn_options,
            api_key=self._api_key,
            reference_id=self._reference_id,
            tenant_id=self._tenant_id,
        )


class FishAudioChunkedStream(agents_tts.ChunkedStream):
    def __init__(
        self,
        *,
        tts: FishAudioTTS,
        input_text: str,
        conn_options: APIConnectOptions,
        api_key: str,
        reference_id: str | None,
        tenant_id: str | None = None,
    ):
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._api_key = api_key
        self._reference_id = reference_id
        self._tenant_id = tenant_id

    async def _run(self, output_emitter: agents_tts.AudioEmitter) -> None:
        # initialize() は _run() の先頭で必ず呼ぶ。
        # 呼ばずに return/例外で抜けると _main_task の end_input() が
        # "AudioEmitter isn't started" RuntimeError を投げるため。
        # mime_type="audio/mpeg" → AudioEmitter が PyAV 経由で MP3 → PCM デコードする。
        output_emitter.initialize(
            request_id=f"fish-audio-{id(self)}",
            sample_rate=self._tts.sample_rate,
            num_channels=self._tts.num_channels,
            mime_type="audio/mpeg",
            stream=False,
        )
        try:
            request_body = {
                "text": self._input_text,
                "model": "s2-pro",  # Phase A: S2-Pro 明示指定（デフォルト依存を排除）
                "format": "mp3",   # Fish Audio デフォルト形式。WAV より確実。
                "normalize": True,
                "latency": "balanced",
            }
            if self._reference_id:
                request_body["reference_id"] = self._reference_id

            logger.info(f"[TTS] requesting Fish Audio: text={self._input_text[:60]!r} ref={self._reference_id}")
            started_at = time.monotonic()
            total_bytes = 0
            async with aiohttp.ClientSession() as http_session:
                async with http_session.post(
                    "https://api.fish.audio/v1/tts",
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                    },
                    json=request_body,
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp:
                    logger.info(f"[TTS] Fish Audio response: status={resp.status} content-type={resp.content_type}")
                    if resp.status != 200:
                        error_text = await resp.text()
                        logger.error(f"[TTS] Fish Audio error {resp.status}: {error_text[:300]}")
                        return

                    # Phase B-1: chunk 受信ごとに push して TTFA を短縮
                    # （公式 openai プラグイン ChunkedStream と同パターン。
                    #   capabilities.streaming は False のまま — True にすると
                    #   フレームワークが未実装の stream() を直接呼び NotImplementedError になる）
                    first_chunk_at: float | None = None
                    async for chunk in resp.content.iter_chunked(4096):
                        if not chunk:
                            continue
                        if first_chunk_at is None:
                            first_chunk_at = time.monotonic()
                            logger.info(f"[TTS] TTFA: {(first_chunk_at - started_at) * 1000:.1f}ms")
                        output_emitter.push(chunk)
                        total_bytes += len(chunk)

            if total_bytes < 1000:
                # 旧実装は一括受信後に skip できたが、streaming では既に push 済みのため警告のみ
                logger.warning(f"[TTS] Fish Audio returned suspiciously small audio ({total_bytes} bytes)")
            output_emitter.flush()
            logger.info(f"[TTS] streamed {total_bytes} bytes to emitter OK")

            # 使用量レポート（fire-and-forget）
            if self._tenant_id:
                tts_bytes = len(self._input_text.encode("utf-8"))
                asyncio.ensure_future(_report_tts_usage(self._tenant_id, tts_bytes))
        except Exception as e:
            logger.error(f"[TTS] Exception in _run: {type(e).__name__}: {e}")


# --- Groq LLM (AgentSession 用 — session.say() のコンテキスト保持に使用) ---
groq_llm = openai_plugin.LLM(
    model="llama-3.3-70b-versatile",
    api_key=os.environ["GROQ_API_KEY"],
    base_url="https://api.groq.com/openai/v1",
)


async def entrypoint(ctx: agents.JobContext) -> None:
    # 子プロセスでも確実に再ロード
    for _c in [_here / ".env", _here.parent / ".env"]:
        if _c.exists():
            load_dotenv(dotenv_path=_c, override=True)
            break

    logger.info("=== ENTRYPOINT CALLED ===")
    logger.info(f"[entrypoint] room.name={ctx.room.name}")

    await ctx.connect(auto_subscribe=agents.AutoSubscribe.SUBSCRIBE_ALL)
    logger.info("=== CONNECTED TO ROOM ===")

    # room name から tenantId を復元: "rajiuce-{safeTenantId}-{16hex}"
    def _extract_tenant_id(room_name: str) -> str | None:
        prefix = "rajiuce-"
        if not room_name.startswith(prefix):
            return None
        rest = room_name[len(prefix):]  # "{safeTenantId}-{16hex}"
        if len(rest) < 18:              # 最低: 1文字 + "-" + 16hex
            return None
        # 末尾16文字 = hex、その前の"-"を除いたものが safeTenantId
        if rest[-17:-16] != "-":
            return None
        return rest[:-17] or None

    tenant_id = _extract_tenant_id(ctx.room.name)
    logger.info(f"[entrypoint] extracted tenant_id={tenant_id!r} from room={ctx.room.name!r}")

    # room metadata から avatarConfigId を取得（テストチャットで特定アバターを指定された場合）
    import json as _json
    _meta: dict = {}
    try:
        _meta = _json.loads(ctx.room.metadata or "{}")
    except Exception:
        pass
    import re as _re
    _raw_cfg_id = _meta.get("avatarConfigId")
    _UUID_RE = _re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", _re.IGNORECASE)
    avatar_config_id: str | None = str(_raw_cfg_id) if isinstance(_raw_cfg_id, str) and _UUID_RE.match(_raw_cfg_id) else None
    logger.info(f"[entrypoint] avatar_config_id={'[redacted-uuid]' if avatar_config_id else None} from room metadata")

    # アバター設定を動的取得
    api_url = os.environ.get("RAJIUCE_API_URL", "http://localhost:3100")
    avatar_config = None
    if tenant_id:
        avatar_config = await fetch_avatar_config(tenant_id, api_url, avatar_config_id)

    # 設定を適用（fallback: 環境変数のデフォルト）
    effective_system_prompt = (
        avatar_config.get("personality_prompt") if avatar_config and avatar_config.get("personality_prompt")
        else SYSTEM_PROMPT
    )
    effective_reference_id = (
        avatar_config.get("voice_id") if avatar_config and avatar_config.get("voice_id")
        else os.environ.get("FISH_AUDIO_REFERENCE_ID")
    )
    effective_agent_id = (
        avatar_config.get("lemonslice_agent_id") if avatar_config and avatar_config.get("lemonslice_agent_id")
        else os.environ.get("LEMONSLICE_AGENT_ID", "agent_aee377cb0fec68ea")
    )
    effective_image_url = (
        avatar_config.get("image_url") if avatar_config and avatar_config.get("image_url")
        else None
    )
    # emotion_tags: DB には JSON 文字列で格納される場合と list で届く場合の両対応
    effective_emotion_tags = avatar_config.get("emotion_tags") if avatar_config else None
    if isinstance(effective_emotion_tags, str):
        try:
            effective_emotion_tags = json.loads(effective_emotion_tags)
        except Exception:
            logger.warning(f"[entrypoint] emotion_tags JSON parse failed: {effective_emotion_tags!r}")
            effective_emotion_tags = None
    if not isinstance(effective_emotion_tags, list):
        effective_emotion_tags = []
    effective_emotion_tags = [str(t) for t in effective_emotion_tags if t]

    logger.info(f"[entrypoint] effective config: voice_id={effective_reference_id!r}, agent_id={effective_agent_id!r}, image_url={'set' if effective_image_url else 'none'}, custom_prompt={'yes' if avatar_config and avatar_config.get('personality_prompt') else 'no'}, emotion_tags={len(effective_emotion_tags)} {effective_emotion_tags}")

    fish_tts = FishAudioTTS(
        api_key=os.environ["FISH_AUDIO_API_KEY"],
        reference_id=effective_reference_id,
        tenant_id=tenant_id,
        emotion_tags=effective_emotion_tags,
    )

    session = AgentSession(
        llm=groq_llm,
        tts=fish_tts,
        user_away_timeout=None,
    )

    @session.on("error")
    def on_session_error(ev) -> None:
        """LemonSlice Production Best Practices: pipeline error handling."""
        err = ev.error if hasattr(ev, 'error') else ev
        error_type = type(err).__name__
        is_recoverable = getattr(err, 'recoverable', True)
        inner_error = getattr(err, 'error', None)

        if not is_recoverable:
            logger.error(
                f"[FATAL] Non-recoverable pipeline error ({error_type}): {err}",
                exc_info=inner_error,
            )
        else:
            logger.warning(
                f"[RECOVERABLE] Pipeline error ({error_type}): {err}",
                exc_info=inner_error,
            )

    # フィラーハンドル保持（dict でクロージャ越しに再代入可能にする）
    _filler_state: dict = {"handle": None}
    # SalesFlow 現在ステート保持（dict でクロージャ越しに再代入可能にする）
    _sales_state: dict = {"current": None}

    async def handle_tts_request(reply_text: str) -> None:
        """本体APIの応答テキストをそのままTTSに渡す（Groq呼び出しなし）。"""
        try:
            # thinking_start フィラーが再生中なら interrupt して本来の発話に切り替える
            fh = _filler_state["handle"]
            if fh is not None:
                try:
                    fh.interrupt()
                except Exception:
                    pass
                _filler_state["handle"] = None
            prefix = sales_flow_emotion_prefix(_sales_state["current"])
            logger.info(f"[tts_request] TTS直渡し state={_sales_state['current']!r} prefix={prefix!r} ({len(reply_text)} chars): {reply_text[:80]!r}")
            session.say(prefix + reply_text)
        except Exception as e:
            logger.error(f"[handle_tts_request] error: {e}")

    async def handle_chat(user_text: str) -> None:
        """レガシー/フォールバック: Groq LLM 直接呼び出し → session.say() でTTS再生。"""
        try:
            # 1. Groq LLM で応答生成（毎回新しいSessionで "Session is closed" を回避）
            async with aiohttp.ClientSession() as http:
                reply = await call_groq_llm(user_text, http, system_prompt=effective_system_prompt, tenant_id=tenant_id)
            logger.info(f"[Groq] reply ({len(reply)} chars): {reply!r}")

            # 2. session.say() で FishAudio TTS パイプラインに渡す
            session.say(reply)
            logger.debug(f"[say] sent to TTS: {reply!r}")

            # 3. Data Channel 経由で Widget にもテキスト送信（フォールバックメッセージはスキップ）
            if reply != FALLBACK_MSG and ctx.room.local_participant:
                payload = json.dumps({"type": "agent_reply", "text": reply}).encode()
                logger.debug(f"[data_channel] payload size={len(payload)} bytes, text={reply!r}")
                await ctx.room.local_participant.publish_data(payload, reliable=True)
                logger.info("[data_channel] agent_reply sent to widget")
        except Exception as e:
            logger.error(f"[handle_chat] error: {e}")

    @ctx.room.on("data_received")
    def on_data_received(data_packet):
        try:
            msg = json.loads(data_packet.data.decode())
            msg_type = msg.get("type", "")
            if msg_type == "thinking_start":
                # フィラー再生: APIレスポンス到着まで沈黙を埋める
                logger.info("[data_channel] thinking_start — filler started")
                handle = session.say("少々お待ちください", allow_interruptions=True)
                _filler_state["handle"] = handle
            elif msg_type == "tts_request":
                # Phase6-D: 本体APIの応答テキストをそのままTTSに渡す
                text = msg.get("text", "").strip()
                if text:
                    logger.info(f"[data_channel] tts_request received: {text[:80]}")
                    asyncio.create_task(handle_tts_request(text))
            elif msg_type == "chat":
                # レガシー/フォールバック: agent側でGroq呼び出し
                text = msg.get("text", "").strip()
                if text:
                    logger.info(f"[data_channel] chat received (fallback): {text[:80]}")
                    asyncio.create_task(handle_chat(text))
            elif msg_type == "state_change":
                # I-4: フロー状態に応じて表情プロンプトを差し替え（fire-and-forget）
                state = msg.get("state")
                # SalesFlow 感情タグ注入のためステートを常に保存（STATE_AGENT_PROMPTS 未登録でも保存する）
                if isinstance(state, str):
                    _sales_state["current"] = state
                prompt = STATE_AGENT_PROMPTS.get(state) if isinstance(state, str) else None
                if prompt:
                    logger.info(f"[data_channel] state_change received: state={state}")
                    asyncio.create_task(
                        control_lemonslice("update_agent_prompt", agent_prompt=prompt)
                    )
                else:
                    logger.debug(f"[data_channel] state_change with unknown state, skipping: {state!r}")
            elif msg_type == "widget_connected":
                logger.info("[data_channel] widget_connected received")
                # 挨拶は AgentSession が自動的に行うため、手動呼び出し不要
        except Exception as e:
            logger.warning(f"[data_channel] parse error: {e}")

    # Lemonslice Avatar（失敗してもテキストチャットにフォールバック）
    # DB値（キャラ別）優先、なければ環境変数にフォールバック
    effective_agent_prompt = (
        (avatar_config.get("agent_prompt") if avatar_config else None)
        or os.getenv("AVATAR_PROMPT", "Be friendly and professional. Smile naturally. Use gentle hand gestures when explaining.")
    )
    effective_agent_idle_prompt = (
        (avatar_config.get("agent_idle_prompt") if avatar_config else None)
        or os.getenv("AVATAR_IDLE_PROMPT", "a friendly person smiling and nodding gently")
    )
    logger.info(
        f"[lemonslice] agent_prompt_src={'db' if avatar_config and avatar_config.get('agent_prompt') else 'env'}, "
        f"agent_idle_prompt_src={'db' if avatar_config and avatar_config.get('agent_idle_prompt') else 'env'}"
    )
    try:
        # agent_id と agent_image_url は排他的（両方渡すとエラー）
        if effective_image_url:
            logger.info(f"[lemonslice] using agent_image_url: {effective_image_url[:80]!r}")
            avatar_kwargs = {
                "agent_image_url": effective_image_url,
                "agent_prompt": effective_agent_prompt,
                "idle_timeout": 300,
                "response_done_timeout": 4.0,  # 0.5→4.0: 複数センテンスTTS間の合成待ち(~1-2s)でアイドル遷移しないよう延長
                "agent_idle_prompt": effective_agent_idle_prompt,
                "width": 1080,
                "height": 1920,
                # I-3: LemonSlice API 公式パラメータ。明示 kwarg ではなく **kwargs →
                # extra_payload 経由で API payload にマージされる (plugin avatar.py:55)
                "simulcast": True,
            }
        else:
            avatar_kwargs = {
                "agent_id": effective_agent_id,
                "agent_prompt": effective_agent_prompt,
                "idle_timeout": 300,
                "response_done_timeout": 4.0,  # 0.5→4.0: 同上
                "agent_idle_prompt": effective_agent_idle_prompt,
                "width": 1080,
                "height": 1920,
                "simulcast": True,  # I-3: 同上
            }
        avatar = lemonslice.AvatarSession(**avatar_kwargs)
        # I-4: avatar.start() の戻り値が LemonSlice session_id（plugin avatar.py:132）
        global _lemonslice_session_id
        _lemonslice_session_id = await avatar.start(session, room=ctx.room)
        # 課金: アバター起動成功時刻を記録（_close_avatar でセッション時間を算出）
        _avatar_started_at = time.monotonic()
        logger.info("=== LEMONSLICE AVATAR STARTED ===")
        logger.info(f"[lemonslice] session_id={'SET' if _lemonslice_session_id else 'NOT_AVAILABLE'}")

        # LiveKit 1.5.17: アバターの room 参加を待機（失敗しても続行）
        try:
            await avatar.wait_for_join(timeout=10.0)
            logger.info("=== AVATAR PARTICIPANT JOINED ROOM ===")
        except Exception as e:
            logger.warning(f"[avatar] wait_for_join timeout (continuing): {e}")

        # LiveKit 1.5.17: job shutdown 時に aclose してゾンビアバターを防止
        # (wait_for_shutdown は 1.5.17 に存在しないため add_shutdown_callback を使用)
        async def _close_avatar() -> None:
            # 課金: セッション時間を算出して LemonSlice 使用量をレポート
            try:
                session_ms = int((time.monotonic() - _avatar_started_at) * 1000)
                await _report_avatar_usage(tenant_id, session_ms)
            except Exception as e:
                logger.warning(f"[avatar] usage report on close error (non-fatal): {e}")
            try:
                await avatar.aclose()
                logger.info("[avatar] aclose completed")
            except Exception as e:
                logger.warning(f"[avatar] aclose error: {e}")

        ctx.add_shutdown_callback(_close_avatar)
    except Exception as e:
        logger.warning(f"Lemonslice avatar failed (text-only fallback): {e}")

    await session.start(
        room=ctx.room,
        agent=Agent(
            instructions=effective_system_prompt,
        ),
    )
    logger.info("=== SESSION STARTED ===")

    # LemonSlice idle animation は最初の TTS サイクルまで静止する。
    # session.start() 直後に短い挨拶を送り idle アニメーションを即起動する。
    await asyncio.sleep(1.5)
    initial_greeting = (
        (avatar_config.get("initial_greeting") if avatar_config else None)
        or "こんにちは！何かご質問はありますか？"
    )
    session.say(initial_greeting)
    logger.info(f"[avatar] idle animation kickstart: {initial_greeting!r}")


if __name__ == "__main__":
    agents.cli.run_app(
        agents.WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name="rajiuce-avatar",
        )
    )
