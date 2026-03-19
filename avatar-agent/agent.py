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
import logging
from livekit import agents
from livekit.agents import Agent, AgentSession
from livekit.plugins import lemonslice
from livekit.plugins import openai as openai_plugin

logger = logging.getLogger("rajiuce-avatar")
logger.setLevel(logging.INFO)

logger.info(f"[module] LIVEKIT_URL={os.environ.get('LIVEKIT_URL', 'NOT SET')}")
logger.info(f"[module] LIVEKIT_API_KEY={'SET' if os.environ.get('LIVEKIT_API_KEY') else 'NOT SET'}")
logger.info(f"[module] LEMONSLICE_API_KEY={'SET' if os.environ.get('LEMONSLICE_API_KEY') else 'NOT SET'}")

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

    session = AgentSession(llm=groq_llm)

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
