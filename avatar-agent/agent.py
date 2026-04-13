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
import aiohttp
from livekit import agents, rtc
from livekit.agents import Agent, AgentSession
from livekit.agents import tts as agents_tts
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, APIConnectOptions
from livekit.plugins import lemonslice
from livekit.plugins import openai as openai_plugin

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


# --- Groq LLM 直接呼び出し ---
async def fetch_avatar_config(tenant_id: str, api_url: str) -> dict | None:
    """テナント別アバター設定を内部APIから取得。失敗時はNoneを返す。"""
    try:
        async with aiohttp.ClientSession() as http:
            async with http.get(
                f"{api_url}/api/internal/avatar-config",
                params={"tenantId": tenant_id},
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


class FishAudioTTS(agents_tts.TTS):
    def __init__(self, api_key: str, reference_id: str | None = None, tenant_id: str | None = None):
        super().__init__(
            capabilities=agents_tts.TTSCapabilities(streaming=False),
            sample_rate=44100,
            num_channels=1,
        )
        self._api_key = api_key
        self._reference_id = reference_id
        self._tenant_id = tenant_id
        logger.info(f"[TTS] FishAudioTTS initialized: ref={self._reference_id} tenant={self._tenant_id}")

    def synthesize(
        self,
        text: str,
        *,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
    ) -> "FishAudioChunkedStream":
        return FishAudioChunkedStream(
            tts=self,
            input_text=text,
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
                "format": "mp3",   # Fish Audio デフォルト形式。WAV より確実。
                "normalize": True,
                "latency": "balanced",
            }
            if self._reference_id:
                request_body["reference_id"] = self._reference_id

            logger.info(f"[TTS] requesting Fish Audio: text={self._input_text[:60]!r} ref={self._reference_id}")
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
                    audio_bytes = await resp.read()

            logger.info(f"[TTS] got {len(audio_bytes)} bytes, first4={audio_bytes[:4]!r}")
            if len(audio_bytes) < 1000:
                logger.warning(f"[TTS] Fish Audio returned suspiciously small audio ({len(audio_bytes)} bytes), skipping (will retry)")
                return

            output_emitter.push(audio_bytes)
            output_emitter.flush()
            logger.info("[TTS] pushed to emitter OK")

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

    # アバター設定を動的取得
    api_url = os.environ.get("RAJIUCE_API_URL", "http://localhost:3100")
    avatar_config = None
    if tenant_id:
        avatar_config = await fetch_avatar_config(tenant_id, api_url)

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

    logger.info(f"[entrypoint] effective config: voice_id={effective_reference_id!r}, agent_id={effective_agent_id!r}, image_url={'set' if effective_image_url else 'none'}, custom_prompt={'yes' if avatar_config and avatar_config.get('personality_prompt') else 'no'}")

    fish_tts = FishAudioTTS(
        api_key=os.environ["FISH_AUDIO_API_KEY"],
        reference_id=effective_reference_id,
        tenant_id=tenant_id,
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

    async def handle_chat(user_text: str) -> None:
        """Groq LLM 直接呼び出し → session.say() でTTS再生 → Data Channel でWidget通知"""
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
            if msg_type == "chat":
                text = msg.get("text", "").strip()
                if text:
                    logger.info(f"[data_channel] chat received: {text[:80]}")
                    asyncio.create_task(handle_chat(text))
            elif msg_type == "widget_connected":
                logger.info("[data_channel] widget_connected received")
                # 挨拶は AgentSession が自動的に行うため、手動呼び出し不要
        except Exception as e:
            logger.warning(f"[data_channel] parse error: {e}")

    # Lemonslice Avatar（失敗してもテキストチャットにフォールバック）
    avatar_prompt = os.environ.get(
        "AVATAR_PROMPT",
        "Be friendly and professional. Smile naturally. Use gentle hand gestures when explaining.",
    )
    try:
        # agent_id と agent_image_url は排他的（両方渡すとエラー）
        if effective_image_url:
            logger.info(f"[lemonslice] using agent_image_url: {effective_image_url[:80]!r}")
            avatar_kwargs = {
                "agent_image_url": effective_image_url,
                "agent_prompt": avatar_prompt,
                "idle_timeout": 300,
                "response_done_timeout": 0.5,
                "agent_idle_prompt": os.getenv("AVATAR_IDLE_PROMPT", "a friendly person smiling and nodding gently"),
            }
        else:
            avatar_kwargs = {
                "agent_id": effective_agent_id,
                "agent_prompt": avatar_prompt,
                "idle_timeout": 300,
                "response_done_timeout": 0.5,
                "agent_idle_prompt": os.getenv("AVATAR_IDLE_PROMPT", "a friendly person smiling and nodding gently"),
            }
        avatar = lemonslice.AvatarSession(**avatar_kwargs)
        await avatar.start(session, room=ctx.room)
        logger.info("=== LEMONSLICE AVATAR STARTED ===")
    except Exception as e:
        logger.warning(f"Lemonslice avatar failed (text-only fallback): {e}")

    await session.start(
        room=ctx.room,
        agent=Agent(
            instructions=effective_system_prompt,
        ),
    )
    logger.info("=== SESSION STARTED ===")


if __name__ == "__main__":
    agents.cli.run_app(
        agents.WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name="rajiuce-avatar",
        )
    )
