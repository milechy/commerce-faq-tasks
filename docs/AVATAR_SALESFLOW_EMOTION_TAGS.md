# SalesFlow × Fish Audio S2 感情インラインタグ連動

PR #406 で実装。SalesFlow の会話ステートに応じて Fish Audio S2 の感情インラインタグを動的に切り替え、アバター発話のトーンをステージに合わせる機能。

## 概要

Fish Audio S2 は `[穏やかに]` / `[明るく元気に]` のようなインラインタグを TTS テキストに埋め込むことで発話感情を制御できる。本機能はこれを SalesFlow ステート（clarify / propose / recommend / close）と連動させ、会話段階に合ったトーンで発話させる。

## 2 層感情タグ構成

| 層 | ソース | 適用タイミング | 最大数 |
|---|---|---|---|
| 静的テナントタグ | `avatar_configs.emotion_tags`（DB） | アバター起動時に固定 | 3 個（先頭から） |
| 動的 SalesFlow タグ | `emotion_tags.py`（ステート別マッピング） | 各発話直前に注入 | 1 ブロック |

### 合成順

```
session.say( [SalesFlow動的タグ] + [テナント固定タグ×3] + 本文テキスト )
```

SalesFlow タグは常に先頭に置かれる。未知ステート / None は空文字（フォールバックなし）。

## ステート → タグ マッピング

| SalesFlow ステート | 感情タグ | 意図 |
|---|---|---|
| `clarify` | `[穏やかに]` | ヒアリング段階 — 落ち着いたトーン |
| `propose` | `[明るく元気に]` | 提案段階 — 前向き・明るいトーン |
| `recommend` | `[熱意を込めて]` | 推薦段階 — 積極的なトーン |
| `close` | `[強調]今なら[/強調][明るく]` | クロージング — 強調 + 明るさで背中を押す |

`close` は複合タグ（`[強調]…[/強調][明るく]`）を使用。「今なら」はタグテンプレートの一部であり、応答本文テキストではない。

## データフロー

```
Widget (state_change イベント) → Data Channel → agent.py on_data_received
  → _sales_state["current"] = state (str)
  ↓
handle_tts_request (tts_request イベント)
  → prefix = sales_flow_emotion_prefix(_sales_state["current"])
  → session.say(prefix + reply_text)
  ↓
FishAudioTTS.synthesize()
  → [SalesFlow prefix] + [テナント固定タグ×3] + reply_text
  → Fish Audio API へ送信
```

## 実装ファイル

| ファイル | 役割 |
|---|---|
| `avatar-agent/emotion_tags.py` | ステート → タグ マッピング（純粋関数モジュール） |
| `avatar-agent/test_emotion_tags.py` | ユニットテスト（agent.py / LiveKit 非依存） |
| `avatar-agent/agent.py` | `_sales_state` クロージャ保持 + `handle_tts_request` でのタグ注入 |

`emotion_tags.py` は agent.py / LiveKit に一切依存しない純粋関数モジュールとして設計されており、単体テストが容易。

## 設計上の注意

- **チャットバブルへの影響なし**: タグは `session.say()` 呼び出し時のみ付与。API 応答テキスト自体は変更しない。
- **未知ステートは空文字**: `SALES_FLOW_EMOTION_TAGS` に未登録のステートはタグなしでそのまま発話（音声品質より安全性を優先）。
- **テナント固定タグと並立**: 動的タグとテナント固定タグは独立した層であり、互いに上書きしない。
- **`STATE_AGENT_PROMPTS` 未登録でも保存**: `state_change` 受信時、Lemonslice プロンプト切替対象外のステートでも `_sales_state` には常に保存（感情タグのため）。
