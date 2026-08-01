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

    def test_avatar_aclose_attempted_on_timeout(self):
        """タイムアウト時、re-raise の前に avatar.aclose() をベストエフォートで
        呼んでいることを確認する（LemonSlice側にセッションが作成済みのまま
        放置されるゾンビセッションを防ぐ）。
        """
        src = AGENT_PY.read_text(encoding="utf-8")
        tree = ast.parse(src)
        handler = None
        for node in ast.walk(tree):
            if isinstance(node, ast.ExceptHandler) and node.type is not None:
                if ast.unparse(node.type) == "asyncio.TimeoutError":
                    handler = node
                    break
        assert handler is not None
        aclose_calls = _find_calls(handler, "avatar.aclose")
        assert aclose_calls, (
            "except asyncio.TimeoutError: 内で avatar.aclose() が"
            "呼ばれていません。LemonSlice側にゾンビセッションが残ります。"
        )


class TestAudioOutputResetOnAvatarFailure:
    """I-4 root fix: avatar.start() 失敗時、session.output.audio が
    DataStreamAudioOutput（アバター宛て）に固定されたまま session.start() へ
    進むと、音声が永久に無音になる不具合の回帰ガード。

    plugin avatar.py の replace_audio_tail はネットワーク呼び出し前に走るため、
    失敗の原因（タイムアウト/その他例外）に関わらず output.audio は既に
    差し替わっている。text-only fallback の except Exception 節で
    session.output.audio = None にリセットし、直後の session.start() が
    RoomIO の通常デフォルト音声出力を自動生成できるようにする。
    """

    def test_output_audio_reset_in_text_only_fallback_handler(self):
        src = AGENT_PY.read_text(encoding="utf-8")
        tree = ast.parse(src)
        handler = None
        for node in ast.walk(tree):
            if isinstance(node, ast.ExceptHandler) and node.type is not None:
                if ast.unparse(node.type) == "Exception":
                    segment = ast.get_source_segment(src, node) or ""
                    if "text-only fallback" in segment:
                        handler = node
                        break
        assert handler is not None, (
            "Lemonslice avatar failed (text-only fallback) の except節が"
            "見つかりません。"
        )
        reset_found = False
        for n in ast.walk(handler):
            if (
                isinstance(n, ast.Assign)
                and len(n.targets) == 1
                and isinstance(n.targets[0], ast.Attribute)
                and n.targets[0].attr == "audio"
                and isinstance(n.targets[0].value, ast.Attribute)
                and n.targets[0].value.attr == "output"
                and isinstance(n.value, ast.Constant)
                and n.value.value is None
            ):
                reset_found = True
                break
        assert reset_found, (
            "text-only fallback の except節内に "
            "`session.output.audio = None` のリセットがありません。"
            "avatar.start() 失敗後、音声出力がアバター宛てに固定されたまま"
            "残り、音声が永久に無音になります。"
        )


if __name__ == "__main__":
    classes = [TestAvatarStartWrappedInTimeout, TestAudioOutputResetOnAvatarFailure]
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
