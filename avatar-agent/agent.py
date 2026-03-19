"""
RAJIUCE Avatar Agent — 最小テスト構成
Room接続確認のみ。Groq/Lemonslice/FishSpeech は全てコメントアウト。
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

logger = logging.getLogger("rajiuce-avatar")
logger.setLevel(logging.DEBUG)

logger.info(f"[module] LIVEKIT_URL={os.environ.get('LIVEKIT_URL', 'NOT SET')}")
logger.info(f"[module] LIVEKIT_API_KEY={'SET' if os.environ.get('LIVEKIT_API_KEY') else 'NOT SET'}")
logger.info(f"[module] LIVEKIT_API_SECRET={'SET' if os.environ.get('LIVEKIT_API_SECRET') else 'NOT SET'}")


async def entrypoint(ctx: agents.JobContext) -> None:
    # 子プロセスでも確実に再ロード
    for _c in [_here / ".env", _here.parent / ".env"]:
        if _c.exists():
            load_dotenv(dotenv_path=_c, override=True)
            break

    logger.info("=== ENTRYPOINT CALLED ===")
    logger.info(f"[entrypoint] room.name={ctx.room.name}")
    logger.info(f"[entrypoint] LIVEKIT_URL={os.environ.get('LIVEKIT_URL', 'NOT SET')}")
    logger.info(f"[entrypoint] LIVEKIT_API_KEY={'SET' if os.environ.get('LIVEKIT_API_KEY') else 'NOT SET'}")

    # 接続前にJobInfoをダンプ（トークンが空かどうかを確認）
    try:
        info = ctx._info  # type: ignore[attr-defined]
        logger.info(f"[job] url={getattr(info, 'url', 'N/A')}")
        tok = getattr(info, 'token', '')
        logger.info(f"[job] token_len={len(tok)} token_prefix={tok[:30] if tok else 'EMPTY'}")
    except Exception as _e:
        logger.warning(f"[job] could not read _info: {_e}")

    await ctx.connect(auto_subscribe=agents.AutoSubscribe.SUBSCRIBE_ALL)
    logger.info("=== CONNECTED TO ROOM ===")

    session = AgentSession()
    await session.start(
        room=ctx.room,
        agent=Agent(
            instructions="あなたはテスト用のAIアシスタントです。日本語で応答してください。",
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
