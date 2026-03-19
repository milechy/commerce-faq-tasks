"""
RAJIUCE Avatar Agent
Groq LLM + Fish Speech TTS + Lemonslice Self-Managed Avatar orchestration via LiveKit Agents.
"""

import json
import logging
import os

from dotenv import load_dotenv
from livekit import agents
from livekit.agents import AgentSession

load_dotenv()

logger = logging.getLogger("rajiuce-avatar")
logger.setLevel(logging.INFO)

# --- Groq LLM ---
# LiveKit の OpenAI 互換プラグインで Groq を使う
from livekit.plugins import openai as openai_plugin

groq_llm = openai_plugin.LLM(
    model="llama-3.3-70b-versatile",
    api_key=os.environ["GROQ_API_KEY"],
    base_url="https://api.groq.com/openai/v1",
)

# --- Fish Speech TTS ---
# Fish Audio API は OpenAI TTS 互換ではないため、httpx で直接呼び出す
import httpx


class FishSpeechTTS:
    """Fish Audio TTS — LiveKit Agent 用のシンプルな TTS ラッパー"""

    def __init__(self):
        self.api_key = os.environ["FISH_AUDIO_API_KEY"]
        self.endpoint = "https://api.fish.audio/v1/tts"

    async def synthesize(self, text: str) -> bytes:
        """テキストを音声に変換"""
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                self.endpoint,
                headers={
                    "X-API-Key": self.api_key,
                    "Content-Type": "application/json",
                },
                json={
                    "text": text,
                    "format": "wav",
                    "latency": "balanced",
                    "sample_rate": 24000,
                },
            )
            response.raise_for_status()
            return response.content


fish_tts = FishSpeechTTS()


# --- Lemonslice Avatar ---
# Self-Managed 方式: セッション作成 → LiveKit Room に映像を送信
class LemonsliceAvatar:
    """Lemonslice Self-Managed Avatar"""

    def __init__(self):
        self.api_key = os.environ["LEMONSLICE_API_KEY"]
        self.endpoint = "https://lemonslice.com/api/liveai/sessions"

    async def create_session(
        self,
        livekit_url: str,
        livekit_token: str,
        agent_id: str = None,
        agent_image_url: str = None,
        agent_prompt: str = "Be friendly and professional.",
    ) -> str:
        """Lemonslice セッションを作成"""
        body = {
            "trmpt": agent_prompt,
            "properties": {
                "livekit_url": livekit_url,
                "livekit_token": livekit_token,
            },
        }

        if agent_id:
            body["agent_id"] = agent_id
        elif agent_image_url:
            body["agent_image_url"] = agent_image_url
        else:
            raise ValueError("agent_id or agent_image_url is required")

        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                self.endpoint,
                headers={
                    "X-API-Key": self.api_key,
                    "Content-Type": "application/json",
                },
                json=body,
            )
            response.raise_for_status()
            data = response.json()
            logger.info(f"Lemonslice session created: {data.get('session_id')}")
            return data["session_id"]


lemonslice = LemonsliceAvatar()


# --- LiveKit Agent ---
@agents.rtc_session()
async def entrypoint(ctx: agents.JobContext):
    """LiveKit Agent のエントリポイント"""
    await ctx.connect()

    logger.info(f"Room connected: {ctx.room.name}")

    # TODO: Lemonslice セッション作成
    # テナント情報は Room metadata から取得する設計
    # room_metadata = json.loads(ctx.room.metadata or "{}")
    # agent_id = room_metadata.get("lemonslice_agent_id")

    session = AgentSession()

    await session.start(
        room=ctx.room,
        agent=agents.Agent(
            instructions="あなたは丁寧な自動車販売のAIアシスタントです。在庫情報を正確に伝え、必要に応じて来店を促してください。",
        ),
    )

    logger.info("Agent session started")


if __name__ == "__main__":
    agents.cli.run_app(agents.WorkerOptions(
        entrypoint_fnc=entrypoint,
    ))
