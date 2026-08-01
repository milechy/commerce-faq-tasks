"""
公式 fishaudio.TTS プラグイン統合まわりの純粋関数のテスト
(_resolve_voice_id / _build_emotion_tags_prefix)。

いずれも entrypoint() 冒頭で1回だけ計算され fishaudio.TTS の構築・speak() に
渡される値。DBから来る値(avatar_configs.voice_id / emotion_tags)は
テナント管理者の入力やAI提案結果に由来し、空文字列・None・想定外の型が
混ざることを前提にテストする(「通れば良い」ではなく壊れやすい境界を踏む)。
"""

import os

os.environ.setdefault("GROQ_API_KEY", "test-dummy-key")
os.environ.setdefault("FISH_AUDIO_API_KEY", "test-dummy-key")

import agent  # noqa: E402
from livekit.agents.types import NOT_GIVEN


class TestResolveVoiceId:
    def test_none_returns_not_given(self):
        assert agent._resolve_voice_id(None) is NOT_GIVEN

    def test_empty_string_returns_not_given(self):
        # avatar_configs.voice_id が空文字列で保存されているケース
        # (未設定と空文字列保存を区別しないDB設計。空文字列をそのまま
        # fishaudio.TTS に渡すと Fish Audio API が無効な voice_id として拒否する)。
        assert agent._resolve_voice_id("") is NOT_GIVEN

    def test_real_value_passes_through_unchanged(self):
        assert agent._resolve_voice_id("933563129e564b19a115bedd57b7406a") == (
            "933563129e564b19a115bedd57b7406a"
        )

    def test_whitespace_only_string_is_truthy_and_passes_through(self):
        # 既知の未対応ケース: " "(空白のみ)は Python では truthy なので
        # NOT_GIVEN に落ちずそのまま voice_id として渡ってしまう。
        # DB側にバリデーションが無い場合、Fish Audio API 側で無効な
        # voice_id エラーになる可能性がある(このテストは現在の挙動を
        # 固定するもので、望ましい挙動を主張するものではない)。
        assert agent._resolve_voice_id("   ") == "   "


class TestBuildEmotionTagsPrefix:
    def test_none_returns_empty_string(self):
        assert agent._build_emotion_tags_prefix(None) == ""

    def test_empty_list_returns_empty_string(self):
        assert agent._build_emotion_tags_prefix([]) == ""

    def test_single_tag(self):
        assert agent._build_emotion_tags_prefix(["calm"]) == "[calm]"

    def test_exactly_three_tags_all_included(self):
        assert agent._build_emotion_tags_prefix(["a", "b", "c"]) == "[a][b][c]"

    def test_more_than_three_tags_truncated_to_first_three(self):
        # 旧 FishAudioTTS.synthesize() の挙動踏襲: self._emotion_tags[:3]
        assert agent._build_emotion_tags_prefix(["a", "b", "c", "d", "e"]) == "[a][b][c]"

    def test_order_is_preserved(self):
        assert agent._build_emotion_tags_prefix(["joyful", "calm"]) == "[joyful][calm]"

    def test_whitespace_only_tag_is_not_filtered_here(self):
        # 既知の未対応ケース: entrypoint() 側の
        # `effective_emotion_tags = [str(t) for t in effective_emotion_tags if t]`
        # は空文字列のみを除外し、空白のみの文字列("  "など)は truthy のため
        # 素通しする。ここではその素通しされた入力に対する本関数の実際の
        # 挙動("[  ]"という見た目の悪いプレフィックスになる)を固定している。
        assert agent._build_emotion_tags_prefix(["  ", "calm"]) == "[  ][calm]"

    def test_tag_containing_brackets_is_not_escaped(self):
        # 既知の未対応ケース: タグ自体に "]" を含む場合、プレフィックスの
        # 構文が壊れる(例: "]state["というタグは "[]state[]"のような
        # 不正な形になり得る)。テナント管理画面からemotion_tagsを自由入力
        # できる経路がある場合はこの境界の悪用余地を検討すべきだが、
        # 現状のUI/APIにそのような自由入力経路があるかは別途確認が必要。
        result = agent._build_emotion_tags_prefix(["ordinary]tag"])
        assert result == "[ordinary]tag]"
