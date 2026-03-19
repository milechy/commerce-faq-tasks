"""
RAJIUCE Avatar Agent
Groq LLM + Fish Speech TTS + Lemonslice Self-Managed Avatar orchestration via LiveKit Agents v1.4+.
"""

import logging
import os

import httpx
from dotenv import load_dotenv
from livekit import agents
from livekit.agents import Agent, AgentSession, RoomInputOptions, RoomOutputOptions
from livekit.plugins import lemonslice, silero
from livekit.plugins import openai as openai_plugin

load_dotenv()

logger = logging.getLogger("rajiuce-avatar")
logger.setLevel(logging.INFO)

# --- Groq LLM (OpenAI 互換 API 経由) ---
groq_llm = openai_plugin.LLM(
    model="llama-3.3-70b-versatile",
    api_key=os.environ["GROQ_API_KEY"],
    base_url="https://api.groq.com/openai/v1",
)

# --- Fish Speech TTS ---
# Fish Audio API は OpenAI TTS 互換ではないため httpx で直接呼び出す
# LiveKit TTS パイプラインへの統合は後続ステップで追加予定
class FishSpeechTTS:
    """Fish Audio TTS wrapper for LiveKit Agent"""

    def __init__(self) -> None:
        self.api_key = os.environ.get("FISH_AUDIO_API_KEY", "")
        self.endpoint = "https://api.fish.audio/v1/tts"

    async def synthesize(self, text: str) -> bytes:
        """テキストを音声（WAV）に変換"""
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                self.endpoint,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "text": text,
                    "format": "wav",
                    "latency": "balanced",
                    "sample_rate": 24000,
                },
            )
            resp.raise_for_status()
            return resp.content


fish_tts = FishSpeechTTS()

# --- Lemonslice Avatar 設定 ---
# agent_id は環境変数またはRoom metadataから取得
LEMONSLICE_AGENT_ID = os.environ.get("LEMONSLICE_AGENT_ID", "agent_aee377cb0fec68ea")
AVATAR_PROMPT = os.environ.get(
    "AVATAR_PROMPT",
    "Be friendly and professional. Smile naturally. Use gentle hand gestures when explaining.",
)
AVATAR_IDLE_PROMPT = os.environ.get(
    "AVATAR_IDLE_PROMPT",
    "Look around gently and blink naturally. Maintain a warm, welcoming expression.",
)

# --- LiveKit Agent エントリポイント ---
async def entrypoint(ctx: agents.JobContext) -> None:
    """メインエントリポイント"""
    await ctx.connect()
    logger.info(f"Connected to room: {ctx.room.name}")

    # AgentSession を作成（Groq LLM + Silero VAD）
    # STT は Silero VAD（音声検出のみ）でスタート。Deepgram/Whisper は後で追加可能
    session = AgentSession(
        llm=groq_llm,
        vad=silero.VAD.load(),
    )

    # Lemonslice Avatar（公式プラグイン）を初期化
    # agent_id は Room metadata に lemonslice_agent_id があればそちらを優先
    import json
    room_metadata = json.loads(ctx.room.metadata or "{}")
    agent_id = room_metadata.get("lemonslice_agent_id") or LEMONSLICE_AGENT_ID

    avatar = lemonslice.AvatarSession(
        agent_id=agent_id,
        avatar_prompt=AVATAR_PROMPT,
        idle_prompt=AVATAR_IDLE_PROMPT,
    )

    # アバターを開始して Room に参加させる
    await avatar.start(session, room=ctx.room)
    logger.info(f"Lemonslice avatar started (agent_id={agent_id})")

    # エージェントセッションを開始
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
        room_input=RoomInputOptions(),
        room_output=RoomOutputOptions(),
    )

    # 最初の挨拶
    await session.generate_reply(
        instructions=(
            "ユーザーに明るく挨拶してください。"
            "例: いらっしゃいませ！カーネーション自動車のAIアシスタントです。"
            "どのようなお車をお探しですか？"
        )
    )
    logger.info("Agent session started")


if __name__ == "__main__":
    agents.cli.run_app(agents.WorkerOptions(
        entrypoint_fnc=entrypoint,
    ))
