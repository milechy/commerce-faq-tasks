"""
_report_tts_usage() / _report_avatar_usage() のリトライ・ローカルキュー是正
(Asana GID 1218172937812482)のユニットテスト。

背景: 使用量レポートは元々完全な fire-and-forget で、本体API側の障害
(INTERNAL_API_HMAC_SECRET欠落・ネットワーク瞬断等)が起きると warning ログを
出すだけで計上漏れが確定していた(2026-09-04、tenant=accept、TTS 4件を実測)。
従量課金で上限を設けない方針のため、守るべきは trackUsage の計上そのもの。

このファイルは:
  1. 短いバックオフ付きリトライが正しく効くこと
  2. リトライを使い切った場合にローカルファイルへ永続化されること
  3. 永続化されたキューが次回 flush_pending_usage_reports() で正しく再送・
     再キュー・掃除されること
  4. 複数プロセスの同時フラッシュを想定した rename ベースの排他が安全に
     no-op できること
を固定する。
"""

import asyncio
import json
import os

os.environ.setdefault("FISH_AUDIO_API_KEY", "test-dummy-key")

import pytest

import agent
from agent import (
    _report_tts_usage,
    _report_avatar_usage,
    _report_usage_with_retry,
    _enqueue_pending_usage_report,
    flush_pending_usage_reports,
)


# ---------------------------------------------------------------------------
# フェイクHTTPセッション(test_lemonslice_control.py と同じ最小フェイクの流儀)
# ---------------------------------------------------------------------------

class _FakeResponse:
    def __init__(self, status=200):
        self.status = status

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    def raise_for_status(self):
        if self.status >= 400:
            raise RuntimeError(f"simulated HTTP {self.status}")


class _FakeSession:
    """呼び出しごとに異なる結果を返せるフェイク(results はキューとして消費される)。"""

    def __init__(self, results):
        # results: list[int | Exception] — 200 なら成功、Exception ならその場で送出
        self._results = list(results)
        self.call_count = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    def post(self, *_args, **_kwargs):
        self.call_count += 1
        result = self._results.pop(0) if self._results else 200
        if isinstance(result, Exception):
            raise result
        return _FakeResponse(status=result)


@pytest.fixture(autouse=True)
def _fast_sleep(monkeypatch):
    """retry_delays_sec(1s/3s/9s等)でテストを実際に待たせない。"""
    async def _no_sleep(_seconds):
        return None
    monkeypatch.setattr(agent.asyncio, "sleep", _no_sleep)


@pytest.fixture(autouse=True)
def _hmac_secret(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_HMAC_SECRET", "test-hmac-secret")


@pytest.fixture
def queue_path(tmp_path, monkeypatch):
    path = tmp_path / "pending_usage_reports.jsonl"
    monkeypatch.setattr(agent, "_PENDING_USAGE_REPORTS_PATH", path)
    return path


def _read_queue_lines(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


# ---------------------------------------------------------------------------
# _report_usage_with_retry: 正常系・境界値
# ---------------------------------------------------------------------------

class TestReportUsageWithRetrySuccess:
    def test_成功時は1回だけ呼びキューに何も残さない(self, monkeypatch, queue_path):
        session = _FakeSession(results=[200])
        with monkeypatch.context() as m:
            m.setattr(agent.aiohttp, "ClientSession", lambda *a, **kw: session)
            asyncio.run(_report_usage_with_retry({"tenantId": "t1"}, "TTS", [1.0, 3.0]))
        assert session.call_count == 1
        assert _read_queue_lines(queue_path) == []

    def test_1回目失敗2回目成功なら2回呼びキューに残らない(self, monkeypatch, queue_path):
        session = _FakeSession(results=[RuntimeError("transient"), 200])
        with monkeypatch.context() as m:
            m.setattr(agent.aiohttp, "ClientSession", lambda *a, **kw: session)
            asyncio.run(_report_usage_with_retry({"tenantId": "t1"}, "TTS", [1.0, 3.0]))
        assert session.call_count == 2
        assert _read_queue_lines(queue_path) == []

    def test_境界値_最後の再試行でちょうど成功する(self, monkeypatch, queue_path):
        # retry_delays=[1.0, 3.0] → 合計3回試行できる。3回目でようやく成功。
        session = _FakeSession(results=[RuntimeError("e1"), RuntimeError("e2"), 200])
        with monkeypatch.context() as m:
            m.setattr(agent.aiohttp, "ClientSession", lambda *a, **kw: session)
            asyncio.run(_report_usage_with_retry({"tenantId": "t1"}, "TTS", [1.0, 3.0]))
        assert session.call_count == 3
        assert _read_queue_lines(queue_path) == []


class TestReportUsageWithRetryExhausted:
    def test_全リトライ失敗でキューに1件永続化される(self, monkeypatch, queue_path):
        session = _FakeSession(results=[RuntimeError("e1"), RuntimeError("e2"), RuntimeError("e3")])
        with monkeypatch.context() as m:
            m.setattr(agent.aiohttp, "ClientSession", lambda *a, **kw: session)
            asyncio.run(_report_usage_with_retry({"tenantId": "t1", "ttsTextBytes": 42}, "TTS", [1.0, 3.0]))
        assert session.call_count == 3
        lines = _read_queue_lines(queue_path)
        assert len(lines) == 1
        assert lines[0]["tenantId"] == "t1"
        assert lines[0]["ttsTextBytes"] == 42
        assert lines[0]["_reportLabel"] == "TTS"

    def test_非2xxレスポンスも失敗として扱われリトライされる(self, monkeypatch, queue_path):
        # 是正: 以前は resp.raise_for_status() を呼んでいなかったため、500応答でも
        # 例外を投げず「成功」扱いされていた(=非2xxのサイレント成功バグ)。
        session = _FakeSession(results=[500, 500, 500])
        with monkeypatch.context() as m:
            m.setattr(agent.aiohttp, "ClientSession", lambda *a, **kw: session)
            asyncio.run(_report_usage_with_retry({"tenantId": "t1"}, "TTS", [1.0, 3.0]))
        assert session.call_count == 3
        assert len(_read_queue_lines(queue_path)) == 1

    def test_HMAC秘密鍵欠落は即座に全リトライ失敗しキューされる(self, monkeypatch, queue_path):
        # 実際のP0障害(2026-09-04)の再現: INTERNAL_API_HMAC_SECRET未設定だと
        # _internal_hmac_headers がRuntimeErrorを即座に送出し、ネットワーク呼び出し
        # 自体に到達しない。それでも最終的にキューされることを保証する。
        monkeypatch.delenv("INTERNAL_API_HMAC_SECRET", raising=False)

        def _fail_if_called(*_a, **_kw):
            raise AssertionError("HMAC秘密鍵が無いのにClientSessionが呼ばれた")

        with monkeypatch.context() as m:
            m.setattr(agent.aiohttp, "ClientSession", _fail_if_called)
            asyncio.run(_report_usage_with_retry({"tenantId": "accept"}, "TTS", [1.0, 3.0]))
        lines = _read_queue_lines(queue_path)
        assert len(lines) == 1
        assert lines[0]["tenantId"] == "accept"

    def test_失敗が複数回起きるとキューに複数件積み上がる(self, monkeypatch, queue_path):
        session = _FakeSession(results=[RuntimeError("e")] * 10)
        with monkeypatch.context() as m:
            m.setattr(agent.aiohttp, "ClientSession", lambda *a, **kw: session)
            asyncio.run(_report_usage_with_retry({"tenantId": "t1"}, "TTS", [1.0]))
            asyncio.run(_report_usage_with_retry({"tenantId": "t2"}, "avatar", [1.0]))
        lines = _read_queue_lines(queue_path)
        assert [l["tenantId"] for l in lines] == ["t1", "t2"]


# ---------------------------------------------------------------------------
# _report_tts_usage / _report_avatar_usage: ペイロード組み立ての配線確認
# ---------------------------------------------------------------------------

class TestReportTtsUsageWiring:
    def test_ペイロードにtenantId_bytes_modelが正しく載る(self, monkeypatch, queue_path):
        session = _FakeSession(results=[200])
        with monkeypatch.context() as m:
            m.setattr(agent.aiohttp, "ClientSession", lambda *a, **kw: session)
            asyncio.run(_report_tts_usage("accept", 123, "fish-audio-v1"))
        # 成功時はキューに残らないが、配線確認のため一度失敗させて中身を見る。
        # TTS の既定リトライ回数(_TTS_USAGE_RETRY_DELAYS_SEC=[1.0,3.0,9.0] → 計4回試行)
        # を全て使い切らせる。
        session2 = _FakeSession(results=[RuntimeError("e")] * 4)
        with monkeypatch.context() as m:
            m.setattr(agent.aiohttp, "ClientSession", lambda *a, **kw: session2)
            asyncio.run(_report_tts_usage("accept", 123, "fish-audio-v1"))
        lines = _read_queue_lines(queue_path)
        assert lines[-1] == {
            "tenantId": "accept",
            "ttsTextBytes": 123,
            "ttsModel": "fish-audio-v1",
            "_reportLabel": "TTS",
        }


class TestReportAvatarUsageWiring:
    def test_session_msが0以下ならネットワーク呼び出しもキューもしない(self, monkeypatch, queue_path):
        def _fail_if_called(*_a, **_kw):
            raise AssertionError("session_ms<=0 なのにClientSessionが呼ばれた")
        with monkeypatch.context() as m:
            m.setattr(agent.aiohttp, "ClientSession", _fail_if_called)
            asyncio.run(_report_avatar_usage("accept", 0))
            asyncio.run(_report_avatar_usage("accept", -1))
        assert _read_queue_lines(queue_path) == []

    def test_creditsがLEMONSLICE_CREDITS_PER_MINUTEから切り上げ計算される(self, monkeypatch, queue_path):
        # avatar の既定リトライ回数(_AVATAR_USAGE_RETRY_DELAYS_SEC=[1.0] → 計2回試行)
        # を全て使い切らせる。
        session = _FakeSession(results=[RuntimeError("e")] * 2)
        with monkeypatch.context() as m:
            m.setattr(agent.aiohttp, "ClientSession", lambda *a, **kw: session)
            # 1分ちょうど → 24.5credit → 切り上げで25
            asyncio.run(_report_avatar_usage("accept", 60_000))
        lines = _read_queue_lines(queue_path)
        assert lines[0]["avatarCredits"] == 25
        assert lines[0]["avatarSessionMs"] == 60_000
        assert lines[0]["_reportLabel"] == "avatar"


# ---------------------------------------------------------------------------
# flush_pending_usage_reports: キューの再送・掃除
# ---------------------------------------------------------------------------

class TestFlushPendingUsageReports:
    def test_キューファイルが無ければ何もしない(self, queue_path):
        assert not queue_path.exists()
        asyncio.run(flush_pending_usage_reports())  # 例外を投げないことのみ確認

    def test_全件成功すればキューファイルが消える(self, monkeypatch, queue_path):
        _enqueue_pending_usage_report({"tenantId": "t1", "_reportLabel": "TTS"})
        _enqueue_pending_usage_report({"tenantId": "t2", "_reportLabel": "avatar"})
        session = _FakeSession(results=[200, 200])
        with monkeypatch.context() as m:
            m.setattr(agent.aiohttp, "ClientSession", lambda *a, **kw: session)
            asyncio.run(flush_pending_usage_reports())
        assert session.call_count == 2
        assert not queue_path.exists()

    def test_一部だけ再失敗した分は新しいキューファイルに再度積まれる(self, monkeypatch, queue_path):
        _enqueue_pending_usage_report({"tenantId": "ok", "_reportLabel": "TTS"})
        _enqueue_pending_usage_report({"tenantId": "still-failing", "_reportLabel": "avatar"})
        session = _FakeSession(results=[200, RuntimeError("still down")])
        with monkeypatch.context() as m:
            m.setattr(agent.aiohttp, "ClientSession", lambda *a, **kw: session)
            asyncio.run(flush_pending_usage_reports())
        lines = _read_queue_lines(queue_path)
        assert len(lines) == 1
        assert lines[0]["tenantId"] == "still-failing"

    def test_破損した行はスキップし他の正常な行は処理を続ける(self, monkeypatch, queue_path):
        queue_path.write_text(
            '{"tenantId": "good1", "_reportLabel": "TTS"}\n'
            "not-valid-json\n"
            '{"tenantId": "good2", "_reportLabel": "TTS"}\n',
            encoding="utf-8",
        )
        session = _FakeSession(results=[200, 200])
        with monkeypatch.context() as m:
            m.setattr(agent.aiohttp, "ClientSession", lambda *a, **kw: session)
            asyncio.run(flush_pending_usage_reports())
        assert session.call_count == 2
        assert not queue_path.exists()

    def test_空行だけのキューファイルはエラーにならず消える(self, queue_path):
        queue_path.write_text("\n\n", encoding="utf-8")
        asyncio.run(flush_pending_usage_reports())
        # クレーム(rename)されたファイルは処理後に削除される想定
        assert not queue_path.exists()

    def test_イレギュラー_他プロセスが同時に処理中でも例外を投げない(self, monkeypatch, queue_path):
        # rename が FileNotFoundError を投げる状況(=他プロセスが既に取得済み)を再現する。
        _enqueue_pending_usage_report({"tenantId": "t1", "_reportLabel": "TTS"})

        def _raise_not_found(*_a, **_kw):
            raise FileNotFoundError("simulated: already claimed by another process")

        with monkeypatch.context() as m:
            m.setattr(agent.os, "rename", _raise_not_found)
            asyncio.run(flush_pending_usage_reports())  # 例外を投げないことのみ確認
        # rename が奪われたことにしたので、元ファイルはそのまま(このプロセスからは
        # 触っていない)。

    def test_フラッシュ後に一時claimedファイルが残らない(self, monkeypatch, queue_path, tmp_path):
        _enqueue_pending_usage_report({"tenantId": "t1", "_reportLabel": "TTS"})
        session = _FakeSession(results=[200])
        with monkeypatch.context() as m:
            m.setattr(agent.aiohttp, "ClientSession", lambda *a, **kw: session)
            asyncio.run(flush_pending_usage_reports())
        leftover = list(tmp_path.glob("*.flushing.*"))
        assert leftover == []
