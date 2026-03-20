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
                "latency": "normal",
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


# --- Groq LLM (OpenAI 互換 API 経由) ---
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

    fish_tts = FishAudioTTS(
        api_key=os.environ["FISH_AUDIO_API_KEY"],
        reference_id=os.environ.get("FISH_AUDIO_REFERENCE_ID"),
        tenant_id=tenant_id,
    )

    session = AgentSession(
        llm=groq_llm,
        tts=fish_tts,
        user_away_timeout=None,
    )

    @ctx.room.on("data_received")
    def on_data_received(data_packet):
        try:
            msg = json.loads(data_packet.data.decode())
            msg_type = msg.get("type", "")
            if msg_type == "chat":
                text = msg.get("text", "").strip()
                if text:
                    logger.info(f"[data_channel] chat received: {text[:80]}")
                    session.generate_reply(
                        instructions=f"ユーザーが「{text}」と言いました。適切に日本語で応答してください。"
                    )
            elif msg_type == "widget_connected":
                logger.info("[data_channel] widget_connected received")
                # 挨拶は AgentSession が自動的に行うため、手動 generate_reply は不要
                # （手動で呼ぶと SDK 自動挨拶と二重になり複数の声で長文が再生される）
        except Exception as e:
            logger.warning(f"[data_channel] parse error: {e}")

    # Lemonslice Avatar（失敗してもテキストチャットにフォールバック）
    agent_id = os.environ.get("LEMONSLICE_AGENT_ID", "agent_aee377cb0fec68ea")
    avatar_prompt = os.environ.get(
        "AVATAR_PROMPT",
        "Be friendly and professional. Smile naturally. Use gentle hand gestures when explaining.",
    )
    try:
        avatar = lemonslice.AvatarSession(
            agent_id=agent_id,
            agent_prompt=avatar_prompt,
            idle_timeout=300,  # 5分（デフォルト60秒→300秒に延長）
        )
        await avatar.start(session, room=ctx.room)
        logger.info("=== LEMONSLICE AVATAR STARTED ===")
    except Exception as e:
        logger.warning(f"Lemonslice avatar failed (text-only fallback): {e}")

    await session.start(
        room=ctx.room,
        agent=Agent(
            instructions=(
                "あなたはカーネーション自動車（BROSS新潟）の丁寧なAI営業アシスタントです。"
                "在庫情報を正確に伝え、必要に応じて来店を促してください。"
                "具体的な金額は提示せず、店長との直接相談をご案内してください。"
                "日本語で応答してください。"
            ),
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
