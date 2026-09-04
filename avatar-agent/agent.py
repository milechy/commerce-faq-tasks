"""
RAJIUCE Avatar Agent
Lemonslice Self-Managed Avatar orchestration via LiveKit Agents v1.4+.

このエージェントは回答を生成しない。本体API /api/chat が RAG(FAQ/pgvector/
learned_memory/tuning_rules)を通して生成した応答テキストを widget から data channel
の tts_request で受け取り、TTS 再生するだけ。ここで LLM を直接呼んで回答を作ると
知識を通さない回答経路になるため、絶対に追加しないこと。

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
import hashlib
import hmac
import json
import logging
import math
import time
import aiohttp
from livekit import agents, rtc
from livekit.agents import Agent, AgentSession
from livekit.agents.types import NOT_GIVEN
from livekit.agents.voice import SpeechHandle
from livekit.plugins import fishaudio
from livekit.plugins import lemonslice
from emotion_tags import sales_flow_emotion_prefix

logger = logging.getLogger("rajiuce-avatar")
logger.setLevel(logging.INFO)

logger.info(f"[module] LIVEKIT_URL={os.environ.get('LIVEKIT_URL', 'NOT SET')}")
logger.info(f"[module] LIVEKIT_API_KEY={'SET' if os.environ.get('LIVEKIT_API_KEY') else 'NOT SET'}")
logger.info(f"[module] LEMONSLICE_API_KEY={'SET' if os.environ.get('LEMONSLICE_API_KEY') else 'NOT SET'}")


# --- 内部API HMAC 署名 ---------------------------------------------------------
# 本体(R2C/Express)の内部APIは、loopback限定 + 固定ヘッダ X-Internal-Request に
# 加えて HMAC-SHA256 署名を要求する（body.tenantId 全信用による偽課金・他テナント
# 注入・設定漏洩を防ぐ P0 対策）。署名方式は TS 側と厳密一致させること:
#   src/lib/crypto/hmacVerifier.ts / cloudflare-workers/.../lib/hmacSigner.ts
#     message   = f"{timestamp}:{JSON.stringify(payload)}"
#     JSON.stringify 相当 = 区切り compact(",", ":") ・ 非ASCII 素通し(ensure_ascii=False)
#     signature = HMAC-SHA256(secret, message) の hex 小文字
#     timestamp = Unix 秒（サーバ許容誤差 ±300 秒）
#     ヘッダ    = X-HMAC-Timestamp / X-HMAC-Signature
# サーバ側は受信ボディを parse 後 JSON.stringify で再直列化して検証するため、
# 送信時の空白やキー順は payload(dict)の挿入順と一致していれば wire 表現に依存しない。
# GET(ボディ無し)の署名対象は空オブジェクト {}（サーバ側 express.json が
# req.body={} にするため）。
def _internal_hmac_headers(payload: object) -> dict:
    """内部API向け HMAC 署名ヘッダを返す。

    secret 未設定なら RuntimeError を送出する（fail-closed）。呼び出し側は
    try/except で握って「送らない/取得失敗」に degrade すること。サーバ側も
    secret 未設定・署名不正・欠落はいずれも拒否する。
    """
    secret = os.environ.get("INTERNAL_API_HMAC_SECRET")
    if not secret:
        raise RuntimeError("INTERNAL_API_HMAC_SECRET not set — cannot sign internal API request")
    canonical = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    timestamp = str(int(time.time()))
    message = f"{timestamp}:{canonical}"
    signature = hmac.new(
        secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return {"X-HMAC-Timestamp": timestamp, "X-HMAC-Signature": signature}


# --- 定数 ---
# SYSTEM_PROMPT は Agent(instructions=...) のペルソナ設定にのみ使う。
# このエージェントは回答を生成しない（本体API /api/chat が RAG を通して生成した
# テキストを data channel の tts_request で受け取り、TTS 再生するだけ）ので、
# ここから LLM を呼んで回答を作ってはいけない（知識を通さない回答経路になる）。
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


# LemonSlice Session Control API が受け付けるイベント名の全量（2026-08-01 公式ドキュメント確認済み）。
# https://lemonslice.com/docs/api-reference/control-session
# 未知の名前は HTTP 400 になるが、control_lemonslice() は fire-and-forget で warning に
# 落とすだけのため、誤字（例: アンダースコア表記）があっても無音で失敗し気づけない
# （update_agent_prompt の誤字で I-4 表情切替が実装以来動いていなかった実例がある）。
# 送信前にここで弾き、誤字と本物の障害を区別できるようにする。
LEMONSLICE_CONTROL_EVENTS = frozenset({
    "terminate",
    "update-image",
    "update-agent-prompt",
    "update-idle-prompt",
    "pose-trigger",
    "reset-idle-timeout",
})


async def control_lemonslice(event: str, **kwargs) -> bool:
    """LemonSlice Control API への fire-and-forget ラッパー（失敗は warning のみ・non-fatal）。

    注意: session_id / API キーはログに出さないこと。
    """
    if event not in LEMONSLICE_CONTROL_EVENTS:
        logger.error(f"[lemonslice-control] unknown event name (typo?): {event!r}")
        return False
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


def resolve_category_persona(category: object, category_persona_map: object) -> dict | None:
    """LemonSliceペルソナスワップ: category_change メッセージが指すカテゴリの
    ペルソナ定義(image_url/agent_prompt/idle_prompt/voice_idの一部または全部を持つ辞書)を
    解決する純粋関数(DB/ネットワークに触れない、on_data_received から分離してテスト可能にする)。

    - category が文字列でない(widget側の壊れたメッセージ等) → None
    - category_persona_map が辞書でない(DB異常値・avatar_config取得失敗等) → None
    - 該当カテゴリが未設定、またはマップされた値が辞書でない(DBに不正な形で
      保存された等) → None
    戻り値が None の呼び出し元は、何もしない(ペルソナ切替をスキップする)こと。

    マッチングは大文字小文字・前後空白を無視する(strip/lower正規化)。category は
    queryPlanner.ts が会話ごとに自由生成する値、category_persona_map のキーは
    save_category_persona で店主が入力した値で、双方が独立して生成されるため、
    語彙自体が完全に一致する保証はない(既知の制約)が、表記ゆれだけはここで救う。
    """
    if not isinstance(category, str) or not isinstance(category_persona_map, dict):
        return None
    category_norm = category.strip().lower()
    if not category_norm:
        return None
    for key, value in category_persona_map.items():
        if isinstance(key, str) and key.strip().lower() == category_norm:
            return value if isinstance(value, dict) else None
    return None


async def fetch_avatar_config(
    tenant_id: str, api_url: str, avatar_config_id: str | None = None
) -> tuple[dict | None, bool]:
    """テナント別アバター設定を内部APIから取得し、(config, fetch_ok) を返す。

    fetch_ok=False は「取得に失敗した = 誰のアバターか分からない」。
    (None, True) は「取得できたが、そのテナントに有効なアバターが無い」。

    この2つを必ず区別すること。区別せずに一律 None を返していたため、
    /api/internal/avatar-config が 500 を返していた期間、呼び出し側が
    「アバター未設定」と誤解し、環境変数の汎用エージェント（テナントと
    無関係な第三者の顔）を無言で配信し続けた（2026-08-08）。

    avatar_config_id 指定時は特定アバターを取得（テスト用途）。
    """
    params: dict[str, str] = {"tenantId": tenant_id}
    if avatar_config_id:
        params["avatarConfigId"] = avatar_config_id
    try:
        # GET はボディを持たないため、署名対象は空オブジェクト {}（サーバ側の
        # express.json が req.body={} にするのと一致させる）。
        hmac_headers = _internal_hmac_headers({})
        async with aiohttp.ClientSession() as http:
            async with http.get(
                f"{api_url}/api/internal/avatar-config",
                params=params,
                headers={"X-Internal-Request": "1", **hmac_headers},
                timeout=aiohttp.ClientTimeout(total=5),
            ) as resp:
                if resp.status != 200:
                    logger.warning(f"[avatar-config] API returned {resp.status}")
                    return None, False
                data = await resp.json()
                return data.get("config"), True
    except Exception as e:
        logger.warning(f"[avatar-config] fetch failed: {e}")
        return None, False


def resolve_avatar_identity(
    avatar_config: dict | None, config_fetch_ok: bool, env_agent_id: str | None
) -> dict | None:
    """LemonSlice に渡すアバターの同定情報を決める純関数。

    返り値:
      {"image_url": str} — テナントのアバター写真からトーキングヘッドを生成する
      {"agent_id": str}  — LemonSlice に登録済みのペルソナを使う
      None               — 誰のアバターか確定できない。アバターを起動しない

    None を返すのは「顔が分からないなら誰の顔も出さない」ため。
    以前はここで環境変数のハードコード既定値へ落ちており、設定取得に失敗した
    テナントの訪問者に、そのテナントとは何の関係もない人物が表示されていた。
    テキストチャットへの degrade は呼び出し側で既に実装済みなので、
    起動しないことによる機能不全は起きない。
    """
    # 取得に失敗した = 誰のアバターか不明。この状態で誰かの顔を出してはいけない。
    if not config_fetch_ok:
        return None

    if avatar_config:
        image_url = avatar_config.get("image_url")
        if image_url:
            return {"image_url": image_url}
        agent_id = avatar_config.get("lemonslice_agent_id")
        if agent_id:
            return {"agent_id": agent_id}

    # テナントに有効なアバターが無い場合のみ、運用者が明示的に設定した
    # 環境変数の既定エージェントを使う。ハードコードの既定値は持たない
    # （未設定なら None = アバター無しで、テキストチャットとして成立する）。
    if env_agent_id:
        return {"agent_id": env_agent_id}
    return None


# --- 使用量レポートの再送・永続化キュー ---------------------------------------
# 2026-09-04(Asana GID 1218172937812482): TTS/アバターの使用量レポートは
# fire-and-forgetで、本体API側の障害(INTERNAL_API_HMAC_SECRET欠落・ネットワーク
# 瞬断等)時にレポートが失われ計上漏れになることを実測で確認した(2026-09-04、
# tenant=accept、TTS 4件が"non-critical"扱いのwarningログに埋もれて消えた)。
# 従量課金で上限を設けない方針(project_usage_based_billing_no_caps)のため、
# 守るべきは trackUsage の計上そのもの。
#
# 対策は二段構え:
#   1. 短いバックオフ付きでその場で再試行する(ネットワーク瞬断・一時的な
#      5xxなど、数秒〜十数秒で解消する障害に強い)。
#   2. それでも失敗したペイロードはローカルファイルに永続化し、次に起動する
#      別のジョブプロセスの entrypoint 冒頭で再送を試みる(このプロセス自身が
#      すぐ終了しても計上漏れが確定しない)。全プロセス停止中に起きた障害は
#      次のセッションが来るまで送れないが、それでも「二度と送られない」より
#      大幅に良い。
#
# 複数ジョブプロセスが同時にキューファイルへ触りうる(LiveKit Agentsは
# セッションごとに別プロセスで entrypoint を実行しうる)ため:
#   - 追記(_enqueue_pending_usage_report): open(..., "a") での1回の write() は
#     POSIX上atomicなため、ロック無しで安全(1行が短い前提)。
#   - フラッシュ(flush_pending_usage_reports): os.rename() のatomic性を使って
#     「フラッシュ権」を1プロセスだけに与える。renameが失敗する(相手が
#     既に処理中/ファイルが存在しない)場合は黙ってスキップする。

_PENDING_USAGE_REPORTS_PATH = Path(os.environ.get(
    "AVATAR_PENDING_USAGE_REPORTS_PATH",
    str(_here / "pending_usage_reports.jsonl"),
))
# TTS(fire-and-forgetで誰も待たない)は長めに粘る。アバターセッション終了時の
# 課金(下記_report_avatar_usage)はshutdownフックの中でawaitされるため、
# プロセスがそのまま終了してもキューへ確実に落とせるよう短く抑える。
_TTS_USAGE_RETRY_DELAYS_SEC = [1.0, 3.0, 9.0]
_AVATAR_USAGE_RETRY_DELAYS_SEC = [1.0]


async def _post_usage_payload(api_url: str, payload: dict) -> None:
    """/api/internal/usage へ1回だけPOSTする(リトライ・キューは呼び出し元の責務)。"""
    hmac_headers = _internal_hmac_headers(payload)
    async with aiohttp.ClientSession() as http_session:
        async with http_session.post(
            f"{api_url}/api/internal/usage",
            headers={"X-Internal-Request": "1", "Content-Type": "application/json", **hmac_headers},
            json=payload,
            timeout=aiohttp.ClientTimeout(total=5),
        ) as resp:
            resp.raise_for_status()


def _enqueue_pending_usage_report(payload: dict) -> None:
    """リトライを使い切っても送れなかった使用量ペイロードをローカルに永続化する。"""
    try:
        line = json.dumps(payload, ensure_ascii=False) + "\n"
        with open(_PENDING_USAGE_REPORTS_PATH, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception as e:
        # 永続化そのものが失敗した場合、これ以上できることが無い最終防衛ライン。
        logger.error(f"[usage] failed to persist pending usage report (data loss): {e}")


async def _report_usage_with_retry(payload: dict, report_label: str, retry_delays_sec: list[float]) -> None:
    """使用量レポートを短いバックオフ付きで再試行し、それでも失敗したらローカルに
    キューして次回のプロセス起動時の再送(flush_pending_usage_reports)に委ねる。
    """
    api_url = os.environ.get("RAJIUCE_API_URL", "http://localhost:3100")
    last_err: Exception | None = None
    for attempt, delay in enumerate([0.0, *retry_delays_sec]):
        if delay:
            await asyncio.sleep(delay)
        try:
            await _post_usage_payload(api_url, payload)
            if attempt > 0:
                logger.info(f"[usage] {report_label} usage report succeeded on retry {attempt}: {payload}")
            else:
                logger.debug(f"[usage] {report_label} usage reported: {payload}")
            return
        except Exception as e:
            last_err = e
    # リトライを使い切っても送れなかった。以前はwarningでnon-critical扱いされ
    # 埋もれていたため、可視性のためerrorに格上げしローカルへキューする。
    logger.error(
        f"[usage] {report_label} usage report failed after {len(retry_delays_sec)} retries, "
        f"queued locally for later retry: {last_err}"
    )
    _enqueue_pending_usage_report({**payload, "_reportLabel": report_label})


async def flush_pending_usage_reports() -> None:
    """前回以前に送れなかった使用量レポートの再送を試みる。ジョブプロセスの
    entrypoint冒頭で毎回呼ぶ想定(呼び出し側でfire-and-forgetにし、このセッション
    自体の開始を遅らせないこと)。
    """
    if not _PENDING_USAGE_REPORTS_PATH.exists():
        return
    claimed_path = _PENDING_USAGE_REPORTS_PATH.with_name(
        f"{_PENDING_USAGE_REPORTS_PATH.name}.flushing.{os.getpid()}"
    )
    try:
        os.rename(_PENDING_USAGE_REPORTS_PATH, claimed_path)
    except FileNotFoundError:
        return  # 他プロセスが既に処理中、またはその間に空になった
    except Exception as e:
        logger.warning(f"[usage] pending usage report flush: rename failed (non-fatal): {e}")
        return

    try:
        with open(claimed_path, "r", encoding="utf-8") as f:
            lines = [line for line in f if line.strip()]
    except Exception as e:
        logger.error(f"[usage] pending usage report flush: failed to read queue file: {e}")
        return

    api_url = os.environ.get("RAJIUCE_API_URL", "http://localhost:3100")
    still_pending: list[str] = []
    flushed_count = 0
    for line in lines:
        try:
            payload = json.loads(line)
        except Exception:
            logger.error(f"[usage] pending usage report flush: dropping unparsable line: {line!r}")
            continue
        report_label = payload.pop("_reportLabel", "unknown")
        try:
            await _post_usage_payload(api_url, payload)
            flushed_count += 1
        except Exception as e:
            logger.warning(f"[usage] pending usage report flush: still failing, re-queueing: {e}")
            still_pending.append(json.dumps({**payload, "_reportLabel": report_label}, ensure_ascii=False) + "\n")

    if still_pending:
        with open(_PENDING_USAGE_REPORTS_PATH, "a", encoding="utf-8") as f:
            f.writelines(still_pending)

    try:
        os.remove(claimed_path)
    except FileNotFoundError:
        pass

    if flushed_count or still_pending:
        logger.info(
            f"[usage] pending usage report flush: {flushed_count} sent, {len(still_pending)} still pending"
        )


# --- Fish Audio TTS ---

async def _report_tts_usage(tenant_id: str, tts_text_bytes: int, tts_model: str) -> None:
    """TTS使用量をRAJIUCE APIにレポートする(リトライ+失敗時はローカルキュー、fire-and-forget)。"""
    payload = {"tenantId": tenant_id, "ttsTextBytes": tts_text_bytes, "ttsModel": tts_model}
    await _report_usage_with_retry(payload, "TTS", _TTS_USAGE_RETRY_DELAYS_SEC)


# LemonSlice は約24.5クレジット/分消費（料金表の割当 1000credit/41min・5400/220・15000/610 から逆算）。
LEMONSLICE_CREDITS_PER_MINUTE = 24.5


async def _report_avatar_usage(tenant_id: str, session_ms: int) -> None:
    """LemonSlice アバターのセッション課金をRAJIUCE APIへレポートする
    (リトライ+失敗時はローカルキュー。呼び出し元でawaitされるshutdownフック)。

    セッション時間（ms）→ 分 → クレジット換算（約24.5credit/分）で avatarCredits を報告する。
    本体側 costCalculator が avatarCredits × $0.007/credit で原価計上する。
    """
    if session_ms <= 0:
        return
    minutes = session_ms / 60000.0
    credits = math.ceil(minutes * LEMONSLICE_CREDITS_PER_MINUTE)
    payload = {"tenantId": tenant_id, "avatarCredits": credits, "avatarSessionMs": session_ms}
    await _report_usage_with_retry(payload, "avatar", _AVATAR_USAGE_RETRY_DELAYS_SEC)


def _build_agent_reply_payload(text: str) -> bytes:
    """agent_reply 形式の Data Channel payload を組み立てる（純粋関数）。"""
    return json.dumps({"type": "agent_reply", "text": text}).encode()


def _resolve_voice_id(reference_id: str | None) -> str | object:
    """fishaudio.TTS の voice_id 引数を解決する（純粋関数）。

    reference_id が None または空文字列の場合は NOT_GIVEN を返し、プラグインの
    デフォルト音声(DEFAULT_VOICE_ID)を使わせる。空文字列を素通しすると
    Fish Audio API が無効な voice_id として拒否するため、None と同じ扱いにする。
    """
    return reference_id if reference_id else NOT_GIVEN


def _build_emotion_tags_prefix(emotion_tags: list[str] | None) -> str:
    """テナントDB設定の emotion_tags から TTS用の "[tag][tag]" 形式プレフィックスを
    組み立てる（純粋関数）。最大3個まで採用する（旧 FishAudioTTS.synthesize() の
    挙動を踏襲）。

    既知の未対応ケース: 空白のみのタグ（例 "  "）は真値のためここでは除外されず
    "[  ]" のような見た目のプレフィックスになる。entrypoint() 側の
    `effective_emotion_tags = [str(t) for t in effective_emotion_tags if t]` は
    空文字列のみを除外し、空白のみの文字列までは除外しない。
    """
    if not emotion_tags:
        return ""
    return "".join(f"[{t}]" for t in emotion_tags[:3])


def _compose_speak_texts(
    text: str,
    *,
    emotion_prefix: bool,
    sales_state: str | None,
    emotion_tags_prefix: str,
) -> tuple[str, str]:
    """speak() のテキスト合成ロジック（純粋関数）。(tts_text, publish_text) を返す。

    emotion_tags_prefix（テナントDB設定）は tts_text にのみ適用し、publish_text
    （Widget のチャット吹き出しに送る文字列）には絶対に含めないこと——ここが
    崩れると `[calm][happy]` のような装飾記法がそのまま顧客向けチャットUIに
    露出する（速攻で気づかれる顧客可視のリグレッション）。
    """
    publish_text = (
        sales_flow_emotion_prefix(sales_state) + text if emotion_prefix else text
    )
    tts_text = emotion_tags_prefix + publish_text
    return tts_text, publish_text


async def entrypoint(ctx: agents.JobContext) -> None:
    # 子プロセスでも確実に再ロード
    for _c in [_here / ".env", _here.parent / ".env"]:
        if _c.exists():
            load_dotenv(dotenv_path=_c, override=True)
            break

    logger.info("=== ENTRYPOINT CALLED ===")
    logger.info(f"[entrypoint] room.name={ctx.room.name}")

    # 2026-09-04(GID 1218172937812482): 前回以前に送れなかった使用量レポートの
    # 再送を試みる。このセッション自体の開始を遅らせないようfire-and-forgetにする。
    asyncio.ensure_future(flush_pending_usage_reports())

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
    # tenant_id が取れない = どのテナントの部屋か分からない。取得失敗と同じ扱いにする
    # （この状態で既定アバターを出すと、素性の分からない部屋に誰かの顔を出すことになる）。
    config_fetch_ok = False
    if tenant_id:
        avatar_config, config_fetch_ok = await fetch_avatar_config(tenant_id, api_url, avatar_config_id)

    # 設定を適用（fallback: 環境変数のデフォルト）
    effective_system_prompt = (
        avatar_config.get("personality_prompt") if avatar_config and avatar_config.get("personality_prompt")
        else SYSTEM_PROMPT
    )
    effective_reference_id = (
        avatar_config.get("voice_id") if avatar_config and avatar_config.get("voice_id")
        else os.environ.get("FISH_AUDIO_REFERENCE_ID")
    )
    avatar_identity = resolve_avatar_identity(
        avatar_config, config_fetch_ok, os.environ.get("LEMONSLICE_AGENT_ID")
    )
    effective_agent_id = (avatar_identity or {}).get("agent_id")
    effective_image_url = (avatar_identity or {}).get("image_url")
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

    # LemonSliceペルソナスワップ: カテゴリ名 → {image_url, agent_prompt, idle_prompt, voice_id}
    # のマップ（migration_category_persona.sql の avatar_configs.category_persona_map、JSONB）。
    # 未設定テナントは {} のまま（category_change を受けても何もしない）。
    category_persona_map = (avatar_config.get("category_persona_map") if avatar_config else None) or {}
    if not isinstance(category_persona_map, dict):
        logger.warning(f"[entrypoint] category_persona_map is not a dict, ignoring: {type(category_persona_map)}")
        category_persona_map = {}

    logger.info(f"[entrypoint] effective config: config_fetch_ok={config_fetch_ok}, voice_id={effective_reference_id!r}, agent_id={effective_agent_id!r}, image_url={'set' if effective_image_url else 'none'}, custom_prompt={'yes' if avatar_config and avatar_config.get('personality_prompt') else 'no'}, emotion_tags={len(effective_emotion_tags)} {effective_emotion_tags}, category_personas={len(category_persona_map)}")
    if avatar_identity is None:
        # 沈黙させない: アバターが出ない理由をログの1行目で分かるようにする。
        # 以前はここで無言で第三者にフォールバックしており、9日間気づかれなかった。
        logger.error(
            f"[entrypoint] アバターを起動しません: 設定を解決できませんでした "
            f"(config_fetch_ok={config_fetch_ok}, avatar_config={'あり' if avatar_config else 'なし'})。"
            "内部APIの応答と、テナントに有効なアバターがあるかを確認してください: "
            "docs/AVATAR_CONFIG_500_RECOVERY.md"
        )

    # FISH_AUDIO_TTS_MODEL: env で切替可能（有料モデルへの移行用）。
    # 実際に使用したモデル名は _report_tts_usage() へ申告し、原価計算をモデル別単価に
    # 連動させる(s2.1-pro-free は無料期間中 $0、他は $15/M byte)。
    _tts_model = os.environ.get("FISH_AUDIO_TTS_MODEL", "s2.1-pro-free")
    fish_tts = fishaudio.TTS(
        api_key=os.environ["FISH_AUDIO_API_KEY"],
        model=_tts_model,
        output_format="mp3",
        sample_rate=44100,
        voice_id=_resolve_voice_id(effective_reference_id),
        normalize=True,
        latency_mode="balanced",
    )
    # emotion_tags（テナントDB設定）は公式プラグインにコンストラクタ引数が無いため、
    # speak() が TTS 送信直前にテキスト先頭へ付与する（Widget のチャット吹き出しには漏らさない）。
    _emotion_tags_prefix = _build_emotion_tags_prefix(effective_emotion_tags)

    # llm は渡さない(SDK上オプショナル)。このエージェントは回答を生成せず
    # session.say() で TTS 再生するだけなので、LLM を持たせると「知識を通さない
    # 回答経路」を復活させる余地になる。
    session = AgentSession(
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

    async def _publish_agent_reply(text: str) -> None:
        """Data Channel 経由で Widget のチャット吹き出しへ送信する（fire-and-forget）。"""
        try:
            if not ctx.room.local_participant:
                return
            payload = _build_agent_reply_payload(text)
            logger.debug(f"[data_channel] payload size={len(payload)} bytes, text={text!r}")
            await ctx.room.local_participant.publish_data(payload, reliable=True)
            logger.info("[data_channel] agent_reply sent to widget")
        except Exception as e:
            logger.warning(f"[data_channel] agent_reply publish failed (non-critical): {e}")

    def speak(
        text: str,
        *,
        publish: bool,
        emotion_prefix: bool,
        allow_interruptions: bool | None = None,
    ) -> SpeechHandle:
        """発話の唯一の入口。emotion prefix 適用・課金計上・Data Channel publish を一元化する。

        session.say() を直接呼ばないこと — publish/prefix の付け忘れが過去に
        歓迎メッセージのチャット履歴欠落バグ（agent_reply 未送出）を起こした。
        emotion_tags（テナントDB設定）は _emotion_tags_prefix で TTS 音声にのみ適用し、
        Widget のチャット吹き出しには漏らさない（旧 FishAudioTTS.synthesize() の挙動を踏襲）。
        """
        tts_text, publish_text = _compose_speak_texts(
            text,
            emotion_prefix=emotion_prefix,
            sales_state=_sales_state["current"],
            emotion_tags_prefix=_emotion_tags_prefix,
        )
        say_kwargs = {} if allow_interruptions is None else {"allow_interruptions": allow_interruptions}
        handle = session.say(tts_text, **say_kwargs)
        if tenant_id:
            asyncio.ensure_future(
                _report_tts_usage(tenant_id, len(tts_text.encode("utf-8")), _tts_model)
            )
        if publish:
            asyncio.create_task(_publish_agent_reply(publish_text))
        return handle

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
            speak(reply_text, publish=False, emotion_prefix=True)
        except Exception as e:
            logger.error(f"[handle_tts_request] error: {e}")

    @ctx.room.on("data_received")
    def on_data_received(data_packet):
        try:
            msg = json.loads(data_packet.data.decode())
            msg_type = msg.get("type", "")
            if msg_type == "thinking_start":
                # フィラー再生: APIレスポンス到着まで沈黙を埋める
                logger.info("[data_channel] thinking_start — filler started")
                handle = speak("少々お待ちください", publish=False, emotion_prefix=False, allow_interruptions=True)
                _filler_state["handle"] = handle
            elif msg_type == "tts_request":
                # Phase6-D: 本体APIの応答テキストをそのままTTSに渡す
                text = msg.get("text", "").strip()
                if text:
                    logger.info(f"[data_channel] tts_request received: {text[:80]}")
                    asyncio.create_task(handle_tts_request(text))
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
                        control_lemonslice("update-agent-prompt", agent_prompt=prompt)
                    )
                else:
                    logger.debug(f"[data_channel] state_change with unknown state, skipping: {state!r}")
            elif msg_type == "category_change":
                # LemonSliceペルソナスワップ: 話題カテゴリの変化に応じて見た目・人格・声を
                # 切り替える（LiveKit接続は維持したまま、fire-and-forget）。
                category = msg.get("category")
                persona = resolve_category_persona(category, category_persona_map)
                if persona is not None:
                    logger.info(f"[data_channel] category_change received: category={category}")
                    if persona.get("image_url"):
                        asyncio.create_task(
                            control_lemonslice("update-image", image_url=persona["image_url"])
                        )
                    if persona.get("agent_prompt"):
                        asyncio.create_task(
                            control_lemonslice("update-agent-prompt", agent_prompt=persona["agent_prompt"])
                        )
                    if persona.get("idle_prompt"):
                        asyncio.create_task(
                            control_lemonslice("update-idle-prompt", idle_prompt=persona["idle_prompt"])
                        )
                    if isinstance(persona.get("voice_id"), str) and persona["voice_id"]:
                        # 次回 TTS 合成から声を切り替える。公式 fishaudio.TTS は
                        # update_options() でインスタンスの声設定を更新できる
                        # （TTSインスタンスの再生成は不要）。
                        fish_tts.update_options(voice_id=persona["voice_id"])
                else:
                    logger.debug(f"[data_channel] category_change with unmapped category, skipping: {category!r}")
            elif msg_type == "widget_connected":
                logger.info("[data_channel] widget_connected received")
                # 挨拶は AgentSession が自動的に行うため、手動呼び出し不要
            elif msg_type == "pip_heartbeat":
                # PiP常駐: パネルを閉じている間、widget側が定期的に送るハートビート。
                # LemonSlice側の idle_timeout(300秒)より短い周期で reset-idle-timeout を
                # 送ることで、PiP表示中にアバターが途中で固まるのを防ぐ(fire-and-forget)。
                asyncio.create_task(control_lemonslice("reset-idle-timeout"))
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
        # 誰のアバターか確定できないならアバターを起動しない。
        # ここで raise すると下の except が拾い、音声出力を戻したうえで
        # テキストチャットとして継続する（既存の degrade 経路をそのまま使う）。
        if avatar_identity is None:
            raise RuntimeError(
                "アバター設定を解決できないため起動しません"
                f"(config_fetch_ok={config_fetch_ok}, tenant_id={tenant_id!r})。"
                "無関係なアバターを表示しないための意図的な停止です。"
                "テキストチャットは通常どおり利用できます。"
            )
        # agent_id と agent_image_url は排他的（両方渡すとエラー）
        if effective_image_url:
            logger.info(f"[lemonslice] using agent_image_url: {effective_image_url[:80]!r}")
            avatar_kwargs = {
                "agent_image_url": effective_image_url,
                "agent_prompt": effective_agent_prompt,
                "idle_timeout": 300,
                "response_done_timeout": 4.0,  # 0.5→4.0: 複数センテンスTTS間の合成待ち(~1-2s)でアイドル遷移しないよう延長
                "agent_idle_prompt": effective_agent_idle_prompt,
                # width/height 省略 → LemonSlice デフォルト (368×560) を使用
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
                # width/height 省略 → LemonSlice デフォルト (368×560) を使用
                "simulcast": True,  # I-3: 同上
            }
        avatar = lemonslice.AvatarSession(**avatar_kwargs)
        # I-4: avatar.start() の戻り値が LemonSlice session_id（plugin avatar.py:132）
        # avatar.start() 自体にはタイムアウト保護が無い（LemonSlice側の _post() は
        # 最大3リトライ×60秒でハングしうる）。ここで明示的にタイムアウトさせないと、
        # 挨拶も session.start() も一切実行されないまま無言で停止し続ける
        # （wait_for_join の10秒タイムアウトはこの手前で止まるため効かない）。
        global _lemonslice_session_id
        try:
            _lemonslice_session_id = await asyncio.wait_for(
                avatar.start(session, room=ctx.room), timeout=15.0
            )
        except asyncio.TimeoutError:
            logger.warning("[avatar] avatar.start() timed out after 15s (text-only fallback)")
            try:
                await avatar.aclose()
            except Exception:
                pass
            raise
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
        # I-4 root fix: avatar.start() は失敗有無に関わらずネットワーク呼び出し前に
        # session.output.audio を DataStreamAudioOutput (アバター宛て) へ差し替え済み
        # （plugin avatar.py: replace_audio_tail）。失敗時にそのまま session.start() へ
        # 進むと、音声出力が二度と参加しないアバター宛てに固定されたまま残り、
        # テキストと課金だけが動いて音声が永久に無音になる。
        # output.audio を None に戻すと、直後の session.start() が
        # RoomIO の通常デフォルト音声出力を自動生成する（agent_session.py:
        # `if self.output.audio is not None: [warn] ignoring` の分岐を利用）。
        session.output.audio = None

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
    speak(initial_greeting, publish=True, emotion_prefix=False)
    logger.info(f"[avatar] idle animation kickstart: {initial_greeting!r}")


if __name__ == "__main__":
    agents.cli.run_app(
        agents.WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name="rajiuce-avatar",
        )
    )
