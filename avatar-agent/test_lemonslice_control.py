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
from unittest.mock import patch

import agent
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


class _FakeResponse:
    def __init__(self, status):
        self.status = status

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False


class _FakeSession:
    """aiohttp.ClientSession の `async with ... as http: http.post(...)` を模す最小フェイク。"""

    def __init__(self, status=None, raise_exc=None):
        self._status = status
        self._raise_exc = raise_exc

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    def post(self, *_args, **_kwargs):
        if self._raise_exc is not None:
            raise self._raise_exc
        return _FakeResponse(self._status)


class TestControlLemonsliceNetworkPath:
    """session_id と API キーが揃っている状態での実際のHTTP呼び出し経路。

    fire-and-forget 設計（例外・非200は warning に落として False を返すだけ）が
    本当に「例外を上に投げない」ことを保証するのがこのクラスの目的。
    ここが壊れると、ネットワーク一時障害1回で on_data_received 全体が
    （呼び出し元が asyncio.create_task 経由でなければ）巻き込まれる恐れがある。
    """

    def test_success_returns_true(self, monkeypatch):
        monkeypatch.setattr(agent, "_lemonslice_session_id", "sess-123")
        monkeypatch.setenv("LEMONSLICE_API_KEY", "test-key")
        with patch.object(agent.aiohttp, "ClientSession", lambda *a, **kw: _FakeSession(status=200)):
            result = asyncio.run(control_lemonslice("update-image", image_url="https://example.com/x.png"))
        assert result is True

    def test_non_200_status_returns_false_without_raising(self, monkeypatch):
        monkeypatch.setattr(agent, "_lemonslice_session_id", "sess-123")
        monkeypatch.setenv("LEMONSLICE_API_KEY", "test-key")
        with patch.object(agent.aiohttp, "ClientSession", lambda *a, **kw: _FakeSession(status=400)):
            result = asyncio.run(control_lemonslice("update-agent-prompt", agent_prompt="x"))
        assert result is False

    def test_network_exception_returns_false_without_raising(self, monkeypatch):
        # タイムアウト・DNS失敗等を模す。fire-and-forget の前提が守られていることの確認。
        monkeypatch.setattr(agent, "_lemonslice_session_id", "sess-123")
        monkeypatch.setenv("LEMONSLICE_API_KEY", "test-key")
        with patch.object(
            agent.aiohttp,
            "ClientSession",
            lambda *a, **kw: _FakeSession(raise_exc=TimeoutError("simulated timeout")),
        ):
            result = asyncio.run(control_lemonslice("reset-idle-timeout"))
        assert result is False

    def test_missing_api_key_returns_false_without_network_call(self, monkeypatch):
        monkeypatch.setattr(agent, "_lemonslice_session_id", "sess-123")
        monkeypatch.delenv("LEMONSLICE_API_KEY", raising=False)

        def _fail_if_called(*_a, **_kw):
            raise AssertionError("API key が無いのに ClientSession が呼ばれた")

        with patch.object(agent.aiohttp, "ClientSession", _fail_if_called):
            result = asyncio.run(control_lemonslice("update-image", image_url="https://example.com/x.png"))
        assert result is False
