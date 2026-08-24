"""
G2(要件定義v1.3): アバター応答レイテンシ計測の回帰テスト。

役目を終えたら(実測完了・E5の方式決定後)このファイルごと削除する前提の
一時計測に対するテスト。format_g2_latency_log は entrypoint() の外に
切り出した純関数(DB・LiveKit・LLMに一切触れない)。
"""

import os
from types import SimpleNamespace

os.environ.setdefault("GROQ_API_KEY", "test-dummy-key")
os.environ.setdefault("FISH_AUDIO_API_KEY", "test-dummy-key")

import agent  # noqa: E402


def _ev(role="assistant", metrics=None):
    item = SimpleNamespace(role=role, metrics=metrics if metrics is not None else {})
    return SimpleNamespace(item=item)


def test_assistant_turn_with_full_metrics_formats_all_fields():
    ev = _ev(
        role="assistant",
        metrics={
            "e2e_latency": 1.234,
            "llm_node_ttft": 0.456,
            "tts_node_ttfb": 0.321,
            "playback_latency": 0.05,
        },
    )
    line = agent.format_g2_latency_log(ev, "r2c_default", "room-abc")
    assert line is not None
    assert "tenant=r2c_default" in line
    assert "room=room-abc" in line
    assert "e2e_latency_s=1.234" in line
    assert "llm_ttft_s=0.456" in line
    assert "tts_ttfb_s=0.321" in line
    assert "playback_latency_s=0.05" in line


def test_user_turn_is_ignored():
    ev = _ev(role="user", metrics={"e2e_latency": 1.0})
    assert agent.format_g2_latency_log(ev, "r2c_default", "room-abc") is None


def test_assistant_turn_with_no_metrics_returns_none():
    """会話開始直後の挨拶等、計測値が一切無いターン。"""
    ev = _ev(role="assistant", metrics={})
    assert agent.format_g2_latency_log(ev, "r2c_default", "room-abc") is None


def test_assistant_turn_with_partial_metrics_still_logs():
    """e2e_latency が無くても llm_node_ttft だけあればログに出す
    (どこが遅いかの切り分けに使うため、部分的な値も捨てない)。"""
    ev = _ev(role="assistant", metrics={"llm_node_ttft": 0.5})
    line = agent.format_g2_latency_log(ev, "r2c_default", "room-abc")
    assert line is not None
    assert "llm_ttft_s=0.5" in line
    assert "e2e_latency_s=None" in line


def test_missing_metrics_attribute_does_not_raise():
    """ChatMessage 以外の item(AgentHandoff 等)が来ても例外にしない。"""
    item = SimpleNamespace(role="assistant")  # metrics 属性が無い
    ev = SimpleNamespace(item=item)
    assert agent.format_g2_latency_log(ev, "r2c_default", "room-abc") is None


def test_missing_role_attribute_does_not_raise():
    item = SimpleNamespace(metrics={"e2e_latency": 1.0})  # role 属性が無い
    ev = SimpleNamespace(item=item)
    assert agent.format_g2_latency_log(ev, "r2c_default", "room-abc") is None


def test_tenant_id_none_is_handled():
    """super_admin のテストチャット等で tenant_id が None のことがある。"""
    ev = _ev(role="assistant", metrics={"e2e_latency": 1.0})
    line = agent.format_g2_latency_log(ev, None, "room-abc")
    assert line is not None
    assert "tenant=None" in line
