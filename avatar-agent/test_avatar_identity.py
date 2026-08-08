"""
resolve_avatar_identity() のユニットテスト。

背景: 2026-08-08、/api/internal/avatar-config が 500 を返していた期間、
avatar-agent は「取得に失敗した」を「アバター未設定」と同一視して、
環境変数のハードコード既定値 (agent_aee377cb0fec68ea) へ無言でフォールバックしていた。
結果、どのテナントの訪問者にも R2C 公式18体のいずれでもない第三者の顔が表示され、
管理画面は「アバターを起動しました(名前)」と成功表示を出していた。

このテストが守る不変条件は1つ:
  「誰のアバターか確定できないなら、誰の顔も出さない」
テキストチャットへの degrade は呼び出し側に実装済みなので、
起動しないこと自体は機能不全にならない。
"""

from agent import resolve_avatar_identity


class TestFetchFailureNeverShowsSomeoneElse:
    """取得に失敗したら、env に既定値があっても絶対に誰かの顔を出さない。"""

    def test_fetch_failed_returns_none_even_with_env_default(self):
        assert resolve_avatar_identity(None, False, "agent_env_default") is None

    def test_fetch_failed_returns_none_even_if_stale_config_passed(self):
        # 取得失敗時に呼び出し側が古い config を渡してしまっても出さない
        stale = {"image_url": "https://example.com/haruka.png"}
        assert resolve_avatar_identity(stale, False, "agent_env_default") is None

    def test_fetch_failed_with_no_env_returns_none(self):
        assert resolve_avatar_identity(None, False, None) is None


class TestResolvedConfigWins:
    def test_image_url_is_preferred_over_agent_id(self):
        # image_url と agent_id は LemonSlice 側で排他。写真があるならそちらが正
        config = {
            "image_url": "https://example.com/haruka.png",
            "lemonslice_agent_id": "agent_haruka",
        }
        assert resolve_avatar_identity(config, True, "agent_env_default") == {
            "image_url": "https://example.com/haruka.png"
        }

    def test_agent_id_used_when_no_image_url(self):
        config = {"image_url": None, "lemonslice_agent_id": "agent_haruka"}
        assert resolve_avatar_identity(config, True, "agent_env_default") == {
            "agent_id": "agent_haruka"
        }

    def test_tenant_config_wins_over_env_default(self):
        config = {"lemonslice_agent_id": "agent_tenant"}
        assert resolve_avatar_identity(config, True, "agent_env_default") == {
            "agent_id": "agent_tenant"
        }


class TestNoActiveAvatarForTenant:
    """取得は成功したが、そのテナントに有効なアバターが無い場合。"""

    def test_env_default_used_when_operator_set_it(self):
        # 運用者が明示的に設定した既定値のみ使う
        assert resolve_avatar_identity(None, True, "agent_env_default") == {
            "agent_id": "agent_env_default"
        }

    def test_no_config_and_no_env_returns_none(self):
        # ハードコードの既定値を持たない = アバター無しで成立させる
        assert resolve_avatar_identity(None, True, None) is None

    def test_empty_env_string_is_not_used(self):
        # LEMONSLICE_AGENT_ID= (空) を「設定済み」と誤認しない
        assert resolve_avatar_identity(None, True, "") is None


class TestBrokenConfigShapes:
    """avatar_configs は JSONB 由来で欠損しうる。壊れた形でも他人を出さない。"""

    def test_config_with_only_empty_strings_falls_back_to_env(self):
        config = {"image_url": "", "lemonslice_agent_id": ""}
        assert resolve_avatar_identity(config, True, "agent_env_default") == {
            "agent_id": "agent_env_default"
        }

    def test_config_with_only_empty_strings_and_no_env_returns_none(self):
        config = {"image_url": "", "lemonslice_agent_id": ""}
        assert resolve_avatar_identity(config, True, None) is None

    def test_empty_dict_config_falls_back_to_env(self):
        assert resolve_avatar_identity({}, True, "agent_env_default") == {
            "agent_id": "agent_env_default"
        }


class TestNoHardcodedStranger:
    """回帰ガード: 実際に事故を起こした agent_id が返り値に混ざらないこと。"""

    LEAKED = "agent_aee377cb0fec68ea"

    def test_hardcoded_stranger_never_appears_without_explicit_env(self):
        for config, ok in [(None, False), (None, True), ({}, True)]:
            result = resolve_avatar_identity(config, ok, None)
            assert result is None or self.LEAKED not in str(result)
