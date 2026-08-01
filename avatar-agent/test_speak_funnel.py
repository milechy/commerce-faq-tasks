"""
agent.py の speak() ファネル導入を検証するテスト。

speak() / handle_chat / handle_tts_request 等は entrypoint() 内のネストした
クロージャのため、confirmPolicy.test.ts と同じ手法（ソースを読み込んで
契約を検証する）で agent.py の内容を直接検査する。
"""

import ast
import json
import os
from pathlib import Path

# agent.py はモジュールレベルで GROQ_API_KEY / FISH_AUDIO_API_KEY を要求する
# (groq_llm = openai_plugin.LLM(api_key=os.environ["GROQ_API_KEY"], ...))。
os.environ.setdefault("GROQ_API_KEY", "test-dummy-key")
os.environ.setdefault("FISH_AUDIO_API_KEY", "test-dummy-key")

import agent  # noqa: E402

AGENT_PY = Path(__file__).parent / "agent.py"


def _find_session_say_calls(tree: ast.AST) -> list[ast.Call]:
    """AST上で実際に session.say(...) を呼んでいる Call ノードのみを抽出する
    （コメント/docstring中の "session.say()" というテキスト言及は無視する）。
    """
    calls = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "say"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "session"
        ):
            calls.append(node)
    return calls


def _find_function_def(tree: ast.AST, name: str) -> ast.FunctionDef:
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"function {name!r} not found in agent.py")


class TestSessionSayOnlyInsideSpeak:
    def test_session_say_appears_exactly_once(self):
        tree = ast.parse(AGENT_PY.read_text(encoding="utf-8"))
        calls = _find_session_say_calls(tree)
        assert len(calls) == 1, (
            f"session.say(...) の実呼び出しが {len(calls)} 箇所見つかりました。"
            "発話は必ず speak() ヘルパー経由にすること（裸の session.say( を追加しない）。"
        )

    def test_session_say_is_inside_speak_definition(self):
        tree = ast.parse(AGENT_PY.read_text(encoding="utf-8"))
        speak_def = _find_function_def(tree, "speak")
        [call] = _find_session_say_calls(tree)
        assert speak_def.lineno <= call.lineno <= speak_def.end_lineno


class TestBuildAgentReplyPayload:
    def test_payload_matches_wire_format(self):
        payload = agent._build_agent_reply_payload("こんにちは")
        assert json.loads(payload.decode()) == {"type": "agent_reply", "text": "こんにちは"}

    def test_payload_is_bytes(self):
        payload = agent._build_agent_reply_payload("test")
        assert isinstance(payload, bytes)


class TestCallSitesUseSpeakFunnel:
    """DoD: 4箇所（tts_request / handle_chat / filler / 挨拶）全てが speak() 経由。"""

    def test_handle_tts_request_uses_speak_without_publish(self):
        src = AGENT_PY.read_text(encoding="utf-8")
        assert "speak(reply_text, publish=False, emotion_prefix=True)" in src

    def test_handle_chat_skips_publish_for_fallback_message(self):
        src = AGENT_PY.read_text(encoding="utf-8")
        assert "speak(reply, publish=(reply != FALLBACK_MSG), emotion_prefix=False)" in src

    def test_filler_uses_speak_without_publish(self):
        src = AGENT_PY.read_text(encoding="utf-8")
        assert (
            'speak("少々お待ちください", publish=False, emotion_prefix=False, allow_interruptions=True)'
            in src
        )

    def test_initial_greeting_uses_speak_with_publish(self):
        src = AGENT_PY.read_text(encoding="utf-8")
        assert "speak(initial_greeting, publish=True, emotion_prefix=False)" in src


if __name__ == "__main__":
    # pytest なし環境向けフォールバック assert ランナー（test_emotion_tags.py に倣う）
    classes = [
        TestSessionSayOnlyInsideSpeak,
        TestBuildAgentReplyPayload,
        TestCallSitesUseSpeakFunnel,
    ]
    passed = 0
    failed = 0
    for cls in classes:
        runner = cls()
        for t in [m for m in dir(runner) if m.startswith("test_")]:
            try:
                getattr(runner, t)()
                print(f"  PASS  {cls.__name__}.{t}")
                passed += 1
            except AssertionError as e:
                print(f"  FAIL  {cls.__name__}.{t}: {e}")
                failed += 1
    print(f"\n{passed} passed, {failed} failed")
    if failed:
        raise SystemExit(1)
