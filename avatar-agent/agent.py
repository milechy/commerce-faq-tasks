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
import struct
import io
import wave
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

class FishAudioTTS(agents_tts.TTS):
    def __init__(self, api_key: str, reference_id: str | None = None):
        super().__init__(
            capabilities=agents_tts.TTSCapabilities(streaming=False),
            sample_rate=44100,
            num_channels=1,
        )
        self._api_key = api_key
        self._reference_id = reference_id

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
    ):
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._api_key = api_key
        self._reference_id = reference_id

    async def _run(self, output_emitter: agents_tts.AudioEmitter) -> None:
        try:
            request_body = {
                "text": self._input_text,
                "format": "wav",
                "normalize": True,
                "latency": "normal",
            }
            if self._reference_id:
                request_body["reference_id"] = self._reference_id

            logger.info(f"[TTS] Fish Audio request: {self._input_text[:60]}...")
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    "https://api.fish.audio/v1/tts",
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                    },
                    json=request_body,
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp:
                    if resp.status != 200:
                        error_text = await resp.text()
                        logger.error(f"[TTS] Fish Audio error {resp.status}: {error_text[:200]}")
                        return
                    audio_bytes = await resp.read()
                    logger.info(f"[TTS] Got {len(audio_bytes)} bytes from Fish Audio")

            wav_io = io.BytesIO(audio_bytes)
            with wave.open(wav_io, "rb") as wav_file:
                sample_rate = wav_file.getframerate()
                num_channels = wav_file.getnchannels()
                pcm_data = wav_file.readframes(wav_file.getnframes())

            output_emitter.initialize(
                request_id="fish-audio",
                sample_rate=sample_rate,
                num_channels=num_channels,
                mime_type="audio/pcm",
                stream=False,
            )
            output_emitter.push(pcm_data)
            output_emitter.flush()
        except Exception as e:
            logger.error(f"[TTS] Exception: {e}")


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

    fish_tts = FishAudioTTS(
        api_key=os.environ["FISH_AUDIO_API_KEY"],
        reference_id=os.environ.get("FISH_AUDIO_REFERENCE_ID"),
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
                    asyncio.create_task(
                        session.generate_reply(
                            instructions=f"ユーザーが「{text}」と言いました。適切に日本語で応答してください。"
                        )
                    )
            elif msg_type == "widget_connected":
                logger.info("[data_channel] widget_connected — sending greeting")
                asyncio.create_task(
                    session.generate_reply(
                        instructions="ユーザーが接続しました。明るく丁寧に挨拶してください。"
                    )
                )
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
