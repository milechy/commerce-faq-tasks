"""
resolve_category_persona() のユニットテスト。

背景: category_persona_map は avatar_configs.category_persona_map (JSONB) に由来し、
Postgres 側にスキーマ制約が無いため、以下のような「壊れた形」で来ても
on_data_received() をクラッシュさせてはならない:
  - widget 側の壊れたメッセージで category が文字列でない
  - avatar_config 取得失敗などで category_persona_map 自体が dict でない
  - カテゴリは存在するが値が dict でない（不正な形で保存された既存データ）
このテストは「通れば良い」ではなく、上記の壊れやすいポイントを個別に踏む。
"""

from agent import resolve_category_persona


class TestResolveCategoryPersonaHappyPath:
    def test_category_found_with_full_persona(self):
        persona_map = {
            "fashion": {
                "image_url": "https://example.com/fashion.png",
                "agent_prompt": "ファッションに詳しい接客をしてください",
                "idle_prompt": "何かお探しですか？",
                "voice_id": "voice-fashion-1",
            }
        }
        result = resolve_category_persona("fashion", persona_map)
        assert result == persona_map["fashion"]

    def test_category_found_with_partial_persona_fields_only(self):
        # save_category_persona は空白のみのフィールドを保存対象から除外するため、
        # 実際の DB 上のペルソナは voice_id だけ、といった部分的な形が正規のケースになる。
        persona_map = {"beauty": {"voice_id": "voice-beauty-1"}}
        result = resolve_category_persona("beauty", persona_map)
        assert result == {"voice_id": "voice-beauty-1"}


class TestResolveCategoryPersonaBoundary:
    def test_category_not_in_map_returns_none(self):
        persona_map = {"fashion": {"voice_id": "v1"}}
        assert resolve_category_persona("electronics", persona_map) is None

    def test_empty_map_returns_none(self):
        assert resolve_category_persona("fashion", {}) is None

    def test_empty_string_category_returns_none(self):
        # 空文字・空白のみは正規化後に空になるため、意味のあるカテゴリとして扱わない
        # （widget 側が category を送らず msg.get が "" を返すケースを模す）。
        persona_map = {"": {"voice_id": "v1"}, "   ": {"voice_id": "v2"}}
        assert resolve_category_persona("", persona_map) is None
        assert resolve_category_persona("   ", persona_map) is None


class TestResolveCategoryPersonaNormalization:
    """category は queryPlanner.ts が会話ごとに自由生成する値、
    category_persona_map のキーは店主が save_category_persona で入力した値で、
    双方が独立に生成されるため表記ゆれが起きうる。大文字小文字・前後空白の
    ゆれだけは正規化で吸収されることを確認する（語彙自体のズレまでは救えない、
    既知の制約）。
    """

    def test_case_insensitive_match(self):
        persona_map = {"fashion": {"voice_id": "v1"}}
        assert resolve_category_persona("Fashion", persona_map) == {"voice_id": "v1"}
        assert resolve_category_persona("FASHION", persona_map) == {"voice_id": "v1"}

    def test_whitespace_is_trimmed_on_both_sides(self):
        persona_map = {" fashion ": {"voice_id": "v1"}}
        assert resolve_category_persona("fashion", persona_map) == {"voice_id": "v1"}
        assert resolve_category_persona("  Fashion  ", persona_map) == {"voice_id": "v1"}

    def test_vocabulary_mismatch_still_returns_none(self):
        # 正規化で救えるのは表記ゆれのみ。語彙自体が違えば従来通りマッチしない
        # （既知の制約であり、この関数の責務外）。
        persona_map = {"returns": {"voice_id": "v1"}}
        assert resolve_category_persona("return", persona_map) is None
        assert resolve_category_persona("返品", persona_map) is None


class TestResolveCategoryPersonaIrregularInputs:
    def test_category_is_none_returns_none(self):
        # msg.get("category") で未送信時に None になるケース（widget 側の実装ミス等）
        assert resolve_category_persona(None, {"fashion": {"voice_id": "v1"}}) is None

    def test_category_is_non_string_type_returns_none(self):
        # widget が壊れたメッセージで category に数値や配列を送るケース
        for bad_category in (123, ["fashion"], {"nested": "object"}, True):
            assert resolve_category_persona(bad_category, {"fashion": {"voice_id": "v1"}}) is None

    def test_category_persona_map_is_none_returns_none(self):
        # avatar_config 取得失敗時、呼び出し元は category_persona_map に None ではなく
        # `or {}` で空dictを渡す実装だが、この関数自体は None が来ても安全であること。
        assert resolve_category_persona("fashion", None) is None

    def test_category_persona_map_is_not_dict_returns_none(self):
        # DB/avatar_config の異常値を模す（本来 JSONB なので dict 以外は来ないはずだが、
        # 防御的にテストしておく）。
        for bad_map in ("not-a-dict", ["fashion"], 42):
            assert resolve_category_persona("fashion", bad_map) is None

    def test_mapped_value_is_not_dict_returns_none(self):
        # 不正な形で保存された JSONB（本来 object のはずが string/null/array になっている）
        for bad_value in ("just-a-string", None, ["voice-1"], 42):
            persona_map = {"fashion": bad_value}
            assert resolve_category_persona("fashion", persona_map) is None

    def test_persona_map_with_mixed_valid_and_invalid_entries(self):
        # 複数カテゴリのうち一部だけが壊れているケース。壊れていないカテゴリの解決には
        # 影響しないことを確認する。
        persona_map = {
            "fashion": {"voice_id": "v1"},
            "beauty": "corrupted-string-instead-of-object",
            "electronics": None,
        }
        assert resolve_category_persona("fashion", persona_map) == {"voice_id": "v1"}
        assert resolve_category_persona("beauty", persona_map) is None
        assert resolve_category_persona("electronics", persona_map) is None
