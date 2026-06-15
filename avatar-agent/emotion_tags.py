"""
SalesFlow ステート別 Fish Audio S2 感情インラインタグ。

このモジュールはテナント固定の感情タグ（FishAudioTTS._emotion_tags）とは独立した
per-utterance 動的レイヤーを提供する。
タグは session.say() に渡すテキストの先頭に付与する（チャットバブルの content には影響しない）。

合成順: [SalesFlow 動的タグ] + [テナント固定タグ[:3]] + 本文
"""

from __future__ import annotations

# SalesFlow ステート → Fish Audio S2 感情インラインタグ のマッピング
SALES_FLOW_EMOTION_TAGS: dict[str, str] = {
    "clarify": "[穏やかに]",
    "propose": "[明るく元気に]",
    "recommend": "[熱意を込めて]",
    # close は強調ラッパー付き複合タグ（「今なら」はタグテンプレートの一部、応答テキストではない）
    "close": "[強調]今なら[/強調][明るく]",
}


def sales_flow_emotion_prefix(state: str | None) -> str:
    """SalesFlow ステートに対応する感情タグプレフィックスを返す。

    Args:
        state: SalesFlow の現在ステート文字列。None / 空文字 / 未知ステートは "" を返す。

    Returns:
        Fish Audio S2 向けインライン感情タグ文字列。未知ステートは空文字（フォールバックなし）。
    """
    if not state:
        return ""
    return SALES_FLOW_EMOTION_TAGS.get(state, "")
