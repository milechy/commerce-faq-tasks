"""
agent.py の speak() ファネル導入を検証するテスト。

speak() / handle_tts_request 等は entrypoint() 内のネストした
クロージャのため、confirmPolicy.test.ts と同じ手法（ソースを読み込んで
契約を検証する）で agent.py の内容を直接検査する。
"""

import ast
import json
import os
from pathlib import Path

# agent.py はモジュールレベルで FISH_AUDIO_API_KEY を要求する。
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

    def test_empty_string(self):
        payload = agent._build_agent_reply_payload("")
        assert json.loads(payload.decode()) == {"type": "agent_reply", "text": ""}

    def test_text_with_quotes_and_backslashes_round_trips(self):
        # ユーザー入力/LLM生成テキストに引用符・バックスラッシュが混ざるのは
        # 珍しくない（例: 「"保証付き"というのは本当ですか？」）。JSONエスケープが
        # 崩れると Widget 側の JSON.parse がそのメッセージだけ静かに失敗する。
        text = '価格は"応相談"です。パス: C:\\Users\\test\\file'
        payload = agent._build_agent_reply_payload(text)
        assert json.loads(payload.decode())["text"] == text

    def test_text_with_embedded_newlines(self):
        text = "1行目\n2行目\n3行目"
        payload = agent._build_agent_reply_payload(text)
        assert json.loads(payload.decode())["text"] == text

    def test_emoji_and_multibyte_text_round_trips(self):
        text = "🚗新潟で30年の実績✨よろしくお願いします🙏"
        payload = agent._build_agent_reply_payload(text)
        assert json.loads(payload.decode())["text"] == text

    def test_long_text_does_not_raise(self):
        # LLM応答が想定より長く返るケース(プロンプト逸脱・エラー時の長文等)。
        # ここでの責務は「壊れずJSONを組み立てられること」であり、長さ制限は
        # 呼び出し元(本体API側)の責務なのでここでは検証しない。
        text = "あ" * 5000
        payload = agent._build_agent_reply_payload(text)
        assert json.loads(payload.decode())["text"] == text


class TestComposeSpeakTexts:
    """speak() のテキスト合成ロジック(_compose_speak_texts)の振る舞いテスト。

    従来の test_speak_funnel.py の他のテストはソースを文字列/AST照合するのみで、
    実際の入出力(emotion_tags_prefix・SalesFlow prefix・textの合成順序、
    publish_textへの漏洩有無)は一切検証していなかった。ここでは実際に関数を
    呼び出し、合成結果そのものを固定する。
    """

    def test_no_prefixes_returns_text_unchanged(self):
        tts_text, publish_text = agent._compose_speak_texts(
            "こんにちは", emotion_prefix=False, sales_state=None, emotion_tags_prefix=""
        )
        assert tts_text == "こんにちは"
        assert publish_text == "こんにちは"
        assert tts_text == publish_text

    def test_emotion_tags_prefix_applies_to_tts_text_only(self):
        # 最重要の回帰ガード: emotion_tags_prefix (テナントDB設定) が
        # publish_text (Widgetのチャット吹き出し) に絶対に漏れないこと。
        # ここが崩れると "[calm][happy]" のような装飾記法が顧客向けUIに露出する。
        tts_text, publish_text = agent._compose_speak_texts(
            "こんにちは",
            emotion_prefix=False,
            sales_state=None,
            emotion_tags_prefix="[calm][happy]",
        )
        assert tts_text == "[calm][happy]こんにちは"
        assert publish_text == "こんにちは"
        assert "[calm][happy]" not in publish_text

    def test_sales_flow_prefix_applies_to_both_texts_when_emotion_prefix_true(self):
        tts_text, publish_text = agent._compose_speak_texts(
            "今なら特典があります",
            emotion_prefix=True,
            sales_state="close",
            emotion_tags_prefix="",
        )
        expected_sales_prefix = "[強調]今なら[/強調][明るく]"
        assert publish_text == expected_sales_prefix + "今なら特典があります"
        assert tts_text == publish_text  # emotion_tags_prefix が空なので両者一致

    def test_both_prefixes_combine_with_emotion_tags_first(self):
        tts_text, publish_text = agent._compose_speak_texts(
            "本日は特別価格です",
            emotion_prefix=True,
            sales_state="close",
            emotion_tags_prefix="[joyful]",
        )
        sales_prefix = "[強調]今なら[/強調][明るく]"
        # publish_text には emotion_tags_prefix が含まれないこと
        assert publish_text == sales_prefix + "本日は特別価格です"
        # tts_text は publish_text の前に emotion_tags_prefix が付くこと(合成順序固定)
        assert tts_text == "[joyful]" + publish_text
        assert "[joyful]" not in publish_text

    def test_unknown_sales_state_yields_no_sales_prefix(self):
        # sales_flow_emotion_prefix は未知のstateに対して空文字列を返す
        # (test_emotion_tags.py で保証済み)。ここでは speak() の合成側が
        # その空文字列を正しく素通しすることを確認する。
        tts_text, publish_text = agent._compose_speak_texts(
            "テスト", emotion_prefix=True, sales_state="no_such_state", emotion_tags_prefix=""
        )
        assert tts_text == "テスト"
        assert publish_text == "テスト"

    def test_emotion_prefix_false_ignores_sales_state_even_if_set(self):
        # emotion_prefix=False のとき、sales_state に有効な値が入っていても
        # SalesFlow prefix は一切適用されないこと(呼び出し元の意図どおり)。
        tts_text, publish_text = agent._compose_speak_texts(
            "テスト", emotion_prefix=False, sales_state="close", emotion_tags_prefix=""
        )
        assert "強調" not in tts_text
        assert "強調" not in publish_text

    def test_empty_text_does_not_raise(self):
        tts_text, publish_text = agent._compose_speak_texts(
            "", emotion_prefix=True, sales_state="close", emotion_tags_prefix="[calm]"
        )
        # prefix はテキストが空でも付与される(prefix + "" = prefix)
        assert tts_text == "[calm][強調]今なら[/強調][明るく]"
        assert publish_text == "[強調]今なら[/強調][明るく]"

    def test_billing_byte_count_differs_from_char_count_for_japanese_text(self):
        # 課金は tts_text の UTF-8 バイト数(speak() 内 len(tts_text.encode("utf-8")))
        # を計上する。日本語はマルチバイトなので文字数とバイト数が一致しない
        # ——ここを char count で計算するリグレッションが起きると原価が過小計上される。
        tts_text, _ = agent._compose_speak_texts(
            "こんにちは", emotion_prefix=False, sales_state=None, emotion_tags_prefix=""
        )
        char_count = len(tts_text)
        byte_count = len(tts_text.encode("utf-8"))
        assert char_count == 5
        assert byte_count == 15  # 「こんにちは」は1文字3バイト×5文字
        assert byte_count != char_count


class TestCallSitesUseSpeakFunnel:
    """DoD: 3箇所（tts_request / filler / 挨拶）全てが speak() 経由。"""

    def test_handle_tts_request_uses_speak_without_publish(self):
        src = AGENT_PY.read_text(encoding="utf-8")
        assert "speak(reply_text, publish=False, emotion_prefix=True)" in src

    def test_filler_uses_speak_without_publish(self):
        src = AGENT_PY.read_text(encoding="utf-8")
        assert (
            'speak("少々お待ちください", publish=False, emotion_prefix=False, allow_interruptions=True)'
            in src
        )

    def test_initial_greeting_uses_speak_with_publish(self):
        src = AGENT_PY.read_text(encoding="utf-8")
        assert "speak(initial_greeting, publish=True, emotion_prefix=False)" in src


class TestVoiceIdCategorySwitchRegression:
    """category_change によるアバター声切替の回帰ガード。

    背景: 自前 FishAudioTTS 時代は `fish_tts._reference_id = persona["voice_id"]`
    という private 属性への直接代入で声を切り替えていた。公式 fishaudio.TTS は
    この属性を読まない(内部は self._opts.voice_id)ため、この古いパターンが
    復活すると「声が切り替わらない」不具合が無言で再発する
    (update_agent_prompt のイベント名誤字と同種の、fire-and-forgetで気づけない
    パターン)。
    """

    def test_old_private_attribute_assignment_pattern_is_gone(self):
        src = AGENT_PY.read_text(encoding="utf-8")
        assert "fish_tts._reference_id" not in src, (
            "fish_tts._reference_id への直接代入が復活しています。公式"
            " fishaudio.TTS はこの属性を読まないため、声の切り替えが無言で"
            "効かなくなります。fish_tts.update_options(voice_id=...) を使うこと。"
        )

    def test_update_options_is_used_for_voice_switch(self):
        src = AGENT_PY.read_text(encoding="utf-8")
        assert "fish_tts.update_options(voice_id=" in src

    def test_voice_id_is_type_checked_before_switch(self):
        """category_persona_map はテナントDB設定由来で、voice_id が数値や
        リスト等の非文字列で紛れ込んでいても resolve_category_persona() は
        弾かない（dict の値であることしか見ない）。truthy チェックだけで
        fish_tts.update_options(voice_id=...) に渡すと、fishaudio API に
        非文字列が渡り例外化する。isinstance(..., str) を先に見ていること。
        """
        src = AGENT_PY.read_text(encoding="utf-8")
        tree = ast.parse(src)
        found = False
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "isinstance":
                if (
                    len(node.args) == 2
                    and isinstance(node.args[0], ast.Call)
                    and isinstance(node.args[0].func, ast.Attribute)
                    and node.args[0].func.attr == "get"
                    and isinstance(node.args[1], ast.Name)
                    and node.args[1].id == "str"
                ):
                    found = True
                    break
        assert found, (
            "persona.get(\"voice_id\") を isinstance(..., str) で"
            "型チェックしていません。voice_id 型チェック除去の回帰です。"
        )


if __name__ == "__main__":
    # pytest なし環境向けフォールバック assert ランナー（test_emotion_tags.py に倣う）
    classes = [
        TestSessionSayOnlyInsideSpeak,
        TestBuildAgentReplyPayload,
        TestComposeSpeakTexts,
        TestCallSitesUseSpeakFunnel,
        TestVoiceIdCategorySwitchRegression,
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
