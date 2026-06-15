"""
emotion_tags.py のユニットテスト。
agent.py / livekit には依存しない — emotion_tags のみインポート。
"""

from emotion_tags import SALES_FLOW_EMOTION_TAGS, sales_flow_emotion_prefix


class TestSalesFlowEmotionPrefix:
    def test_clarify(self):
        assert sales_flow_emotion_prefix("clarify") == "[穏やかに]"

    def test_propose(self):
        assert sales_flow_emotion_prefix("propose") == "[明るく元気に]"

    def test_recommend(self):
        assert sales_flow_emotion_prefix("recommend") == "[熱意を込めて]"

    def test_close(self):
        assert sales_flow_emotion_prefix("close") == "[強調]今なら[/強調][明るく]"

    def test_close_contains_kyoucho(self):
        result = sales_flow_emotion_prefix("close")
        assert "強調" in result

    def test_close_contains_akaruku(self):
        result = sales_flow_emotion_prefix("close")
        assert "明るく" in result

    def test_none_returns_empty(self):
        assert sales_flow_emotion_prefix(None) == ""

    def test_empty_string_returns_empty(self):
        assert sales_flow_emotion_prefix("") == ""

    def test_unknown_state_returns_empty(self):
        assert sales_flow_emotion_prefix("foo") == ""

    def test_unknown_state_bar_returns_empty(self):
        assert sales_flow_emotion_prefix("bar") == ""

    def test_mapping_has_all_four_states(self):
        for key in ("clarify", "propose", "recommend", "close"):
            assert key in SALES_FLOW_EMOTION_TAGS


if __name__ == "__main__":
    # pytest なし環境向けフォールバック assert ランナー
    runner = TestSalesFlowEmotionPrefix()
    tests = [m for m in dir(runner) if m.startswith("test_")]
    passed = 0
    failed = 0
    for t in tests:
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
