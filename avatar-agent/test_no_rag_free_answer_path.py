"""
E5: アバターが知識(RAG)を通さずに回答を生成する経路が復活しないことを固定する。

背景(2026-08-24 の調査): 稼働中のアバター(lemonslice)は本体API /api/chat が
RAG(FAQ/pgvector/learned_memory/tuning_rules)を通して生成した応答テキストを
data channel の tts_request で受け取り、TTS 再生するだけなので既に知識連動済み。
一方 agent.py には知識を通さない回答経路(handle_chat → call_groq_llm。
system_prompt + user_text だけで Groq を直呼びし、しかも配信停止済みの
llama-3.3-70b-versatile を指していた)が死蔵されていた。本番ログでの発火は
通算0件だったが、data channel に type:"chat" を投げるだけで顧客に知識ゼロの
回答が出る状態だった。

このテストは agent.py を走査して、その経路が再導入されていないことを検査する
(confirmPolicy.test.ts / widgetSourceInvariants.test.ts と同じ流儀)。
"""

import ast
from pathlib import Path

AGENT_PY = Path(__file__).parent / "agent.py"


def _source() -> str:
    return AGENT_PY.read_text(encoding="utf-8")


def _tree() -> ast.AST:
    return ast.parse(_source())


# 回答生成に使える汎用チャット補完エンドポイント。
# TTS(fish audio)・埋め込み・アバター制御など「回答を作らない」外部APIは対象外。
FORBIDDEN_LLM_ENDPOINTS = (
    "/chat/completions",
    "/v1/messages",
    "/v1/responses",
    "generativelanguage.googleapis.com",
)


def test_no_llm_chat_completion_endpoint_is_called():
    """agent.py から LLM のチャット補完APIを直接叩いてはいけない。

    叩けてしまうと、その応答は RAG を経由していないため知識ゼロの回答になる。
    回答生成は本体API /api/chat の責務。
    """
    src = _source()
    for endpoint in FORBIDDEN_LLM_ENDPOINTS:
        assert endpoint not in src, (
            f"agent.py が LLM チャット補完API({endpoint})を参照している。"
            "アバターの回答は本体API /api/chat(RAG経由)が生成したものを "
            'data channel の tts_request で受け取ること。'
        )


def test_agent_session_has_no_llm():
    """AgentSession に llm を渡さない(SDK上オプショナル)。

    llm を持たせると session.generate_reply() で知識を通さない回答を作れてしまう。
    このエージェントは session.say() で TTS 再生するだけ。
    """
    tree = _tree()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
        if name != "AgentSession":
            continue
        kwargs = {kw.arg for kw in node.keywords if kw.arg}
        assert "llm" not in kwargs, (
            "AgentSession に llm が渡されている。回答生成経路を復活させないため "
            "llm は渡さないこと(SDK では NOT_GIVEN 既定でオプショナル)。"
        )


def test_generate_reply_is_never_called():
    """session.generate_reply() を呼ばない(呼べば知識を通さない回答になる)。"""
    tree = _tree()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, "attr", None) == "generate_reply":
            raise AssertionError(
                "generate_reply() が呼ばれている。アバターは回答を生成せず、"
                "本体API /api/chat の応答を TTS 再生するだけにすること。"
            )


def test_data_channel_has_no_answer_generating_message_type():
    """data channel の受信分岐に、回答生成を伴う type を足さない。

    type:"chat" は agent 側で Groq を直呼びして回答を作る経路だった(E5で撤去)。
    再導入すると widget から1メッセージ投げるだけで知識ゼロ回答が顧客に出る。
    """
    src = _source()
    assert 'msg_type == "chat"' not in src, (
        'data channel に type:"chat"(agent側で回答生成)の分岐が復活している。'
        "回答生成は本体API /api/chat の責務。"
    )


def test_deprecated_groq_models_are_not_referenced():
    """配信停止済みモデルIDを参照しない。

    2026-08-23 に Groq が llama-3.3-70b-versatile / llama-3.1-8b-instant を廃止し、
    参照が残ると 404 でフォールバック文言だけが顧客に出る。
    """
    src = _source()
    for model in ("llama-3.3-70b-versatile", "llama-3.1-8b-instant"):
        assert model not in src, f"配信停止済みモデル {model} を参照している。"
