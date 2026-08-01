"""
avatar.start() のタイムアウト保護を検証するテスト。

entrypoint() は多数の副作用(LiveKit room接続・内部API呼び出し)を持つ大きな
関数のため、test_speak_funnel.py と同じ手法（ソースをASTで検査して契約を
固定する）を用いる。

背景: avatar.start()（LemonSlice側セッション作成）にはタイムアウト保護が
無く、ハングすると session.start() も挨拶も一切実行されないまま無言で
停止し続ける不具合があった（LiveKit Cloud dashboard の Sessions で
参加者2人のまま19分以上残留するセッションとして実機確認済み）。
"""

import ast
import os
from pathlib import Path

os.environ.setdefault("GROQ_API_KEY", "test-dummy-key")
os.environ.setdefault("FISH_AUDIO_API_KEY", "test-dummy-key")

AGENT_PY = Path(__file__).parent / "agent.py"


def _find_calls(tree: ast.AST, dotted_name: str) -> list[ast.Call]:
    """dotted_name（例: "avatar.start", "asyncio.wait_for"）にマッチする
    Call ノードを全て返す。
    """
    calls = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        parts = []
        while isinstance(func, ast.Attribute):
            parts.append(func.attr)
            func = func.value
        if isinstance(func, ast.Name):
            parts.append(func.id)
            parts.reverse()
            if ".".join(parts) == dotted_name:
                calls.append(node)
    return calls


class TestAvatarStartWrappedInTimeout:
    def test_avatar_start_is_first_arg_of_wait_for(self):
        tree = ast.parse(AGENT_PY.read_text(encoding="utf-8"))
        wait_for_calls = _find_calls(tree, "asyncio.wait_for")
        wrapped = [
            c
            for c in wait_for_calls
            if c.args
            and isinstance(c.args[0], ast.Call)
            and isinstance(c.args[0].func, ast.Attribute)
            and c.args[0].func.attr == "start"
        ]
        assert wrapped, (
            "avatar.start(...) が asyncio.wait_for(...) の第1引数として"
            "ラップされていません。ハングしても無言で停止し続ける不具合が"
            "再発します。"
        )

    def test_timeout_kwarg_is_reasonable(self):
        tree = ast.parse(AGENT_PY.read_text(encoding="utf-8"))
        wait_for_calls = _find_calls(tree, "asyncio.wait_for")
        [call] = [
            c
            for c in wait_for_calls
            if c.args
            and isinstance(c.args[0], ast.Call)
            and isinstance(c.args[0].func, ast.Attribute)
            and c.args[0].func.attr == "start"
        ]
        timeout_kw = next(kw for kw in call.keywords if kw.arg == "timeout")
        assert isinstance(timeout_kw.value, ast.Constant)
        timeout_value = timeout_kw.value.value
        # LemonSlice側の理論上限(最大3リトライ×60秒)より十分短く、
        # 通常の接続時間(数秒)より十分長い範囲。
        assert 10 <= timeout_value <= 120, (
            f"timeout={timeout_value} が妥当な範囲(10〜120秒)外です。"
        )

    def test_timeout_error_is_reraised_not_swallowed(self):
        """TimeoutError を握りつぶさず外側の except Exception (text-only
        fallback) へ伝播させていることを確認する。
        """
        src = AGENT_PY.read_text(encoding="utf-8")
        tree = ast.parse(src)
        handler = None
        for node in ast.walk(tree):
            if isinstance(node, ast.ExceptHandler) and node.type is not None:
                type_str = ast.unparse(node.type)
                if type_str == "asyncio.TimeoutError":
                    handler = node
                    break
        assert handler is not None, "except asyncio.TimeoutError: が見つかりません"
        has_raise = any(isinstance(n, ast.Raise) for n in ast.walk(handler))
        assert has_raise, (
            "except asyncio.TimeoutError: 内に raise が無く、例外が"
            "握りつぶされています。外側の text-only fallback に届きません。"
        )


if __name__ == "__main__":
    runner = TestAvatarStartWrappedInTimeout()
    passed = 0
    failed = 0
    for t in [m for m in dir(runner) if m.startswith("test_")]:
        try:
            getattr(runner, t)()
            print(f"  PASS  {t}")
            passed += 1
        except AssertionError as e:
            print(f"  FAIL  {t}: {e}")
            failed += 1
    print(f"\n{passed} passed, {failed} failed")
    if failed:
        raise SystemExit(1)
