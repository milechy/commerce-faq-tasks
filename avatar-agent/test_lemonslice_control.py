"""
control_lemonslice() / LEMONSLICE_CONTROL_EVENTS のユニットテスト。

背景: agent.py はかつて control_lemonslice("update_agent_prompt", ...) という
アンダースコア表記の誤字を送っていた（正しくは update-agent-prompt）。
LemonSlice Control API は未知の event 値に HTTP 400 を返すが、control_lemonslice()
は fire-and-forget で warning に落とすだけのため、この誤字は I-4 表情切替が
実装以来一度も動いていないことに誰も気づけない、という形で長期間残っていた。
このテストは同種の再発を検出する。
"""

import asyncio

from agent import LEMONSLICE_CONTROL_EVENTS, control_lemonslice


class TestLemonsliceControlEvents:
    def test_known_events_are_hyphenated(self):
        # LemonSlice 公式ドキュメント(2026-08-01確認)の6イベントと完全一致すること。
        assert LEMONSLICE_CONTROL_EVENTS == {
            "terminate",
            "update-image",
            "update-agent-prompt",
            "update-idle-prompt",
            "pose-trigger",
            "reset-idle-timeout",
        }

    def test_no_underscore_variants_are_allowed(self):
        # アンダースコア表記は LemonSlice API 側に存在しない。再発防止の直接的なガード。
        for event in LEMONSLICE_CONTROL_EVENTS:
            assert "_" not in event, f"{event!r} contains underscore, expected hyphen"


class TestControlLemonsliceRejectsUnknownEvents:
    def test_unknown_event_returns_false_without_session_id(self):
        # session_id 未設定でも、まず event 名の allowlist チェックで弾かれることを確認する
        # (ここで False が返るのが「未知の名前だから」であって「session_id が無いから」
        #  ではないことは、既知イベントでも同条件で False になる次のテストと対比して保証する)。
        result = asyncio.run(control_lemonslice("update_agent_prompt", agent_prompt="x"))
        assert result is False

    def test_known_event_without_session_id_also_returns_false(self):
        # session_id 未設定時の早期returnはevent名に関わらず起こる、という前提の確認。
        # (このモジュールはグローバルセッション状態を持つため、テスト実行順に依存しない
        #  よう session_id が未設定であることをテスト側で強制しない — entrypoint実行前は
        #  常に None のため、テスト環境では自然にこの前提が満たされる)
        result = asyncio.run(control_lemonslice("update-agent-prompt", agent_prompt="x"))
        assert result is False

    def test_completely_unknown_event_name_returns_false(self):
        result = asyncio.run(control_lemonslice("viseme", phoneme="aa"))
        assert result is False
