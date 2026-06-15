# LemonSlice ペルソナスワップ × 商品カテゴリ — 設計ドキュメント

Asana GID: 1215698823592534

## 概要

会話中に話題の商品カテゴリ（家電・ファッション・食品など）が切り替わるタイミングで、LiveKit ルートを切断せずにアバターの「人格」を変更する機能。

- **外見**: LemonSlice Control API の `update_image` で参照画像を差し替え
- **人格プロンプト**: `update_agent_prompt` でペルソナ指示を上書き
- **声質**: Fish Audio `reference_id` を次回 TTS 合成から差し替え

SoShop（参照実装: [lemonsliceai/SoShop](https://github.com/lemonsliceai/SoShop)）が同一パターンを用いている。

---

## 現行アーキテクチャとの差分

| 軸 | 現行 | 本機能追加後 |
|---|---|---|
| アバター外見 | セッション開始時に `agent_id` / `agent_image_url` で固定 | カテゴリ切替時に `update_image` で動的変更 |
| 人格プロンプト | SalesFlow ステートに応じて `update_agent_prompt`（4 ステート） | カテゴリ切替でも `update_agent_prompt`（ペルソナ層として追加） |
| 声質 | テナント単一 `voice_id` | カテゴリごとに異なる `voice_id` |
| LiveKit 接続 | SalesFlow ステート変化で維持 | カテゴリ変化でも維持（再接続なし） |

---

## データフロー

```
1. ユーザー発話
     ↓
2. RAG 検索 → queryPlanner.ts がカテゴリ推定
   （例: "このジャケットに合うスカートは？" → category="fashion"）
     ↓
3. dialog/turn API レスポンスに `ragCategory` フィールドを含める
     ↓
4. Widget が前回カテゴリと比較し、変化があれば DataChannel へ送信
   { "type": "category_change", "category": "fashion" }
     ↓
5. agent.py on_data_received が受信
     ↓
6. category_persona_map[category] を参照
   ├─ update_agent_prompt → ペルソナプロンプト差し替え（即時）
   ├─ update_image        → 参照画像差し替え（即時）
   └─ _effective_reference_id 更新 → 次回 TTS 合成から声質変更
```

---

## カテゴリ検出の仕様

### 既存の queryPlanner カテゴリ

`src/agent/flow/queryPlanner.ts` がクエリから以下を推定:

```
returns / shipping / payment / promotion / product / account
```

本機能では「商品カテゴリ」（業種・売り場区分）を対象とするため、テナントが独自にカテゴリ名を定義する（下記 DB 設計参照）。

### `ragCategory` の解決

1. queryPlanner の出力 `category` フィールドを dialog/turn レスポンスに追加
2. RAG 検索でヒットした FAQ の `category` フィールドを候補として活用
3. テナントが設定した `category_persona_map` にマッチするキーに限り有効とする
4. マッチしない場合は前回ペルソナを維持（デフォルトペルソナに戻さない）

---

## DB スキーマ変更

### avatar_configs テーブル への追加フィールド

```sql
ALTER TABLE avatar_configs
  ADD COLUMN category_persona_map JSONB DEFAULT '{}'::jsonb;
```

### `category_persona_map` の JSON 構造

```json
{
  "electronics": {
    "label": "家電コーナー",
    "agent_image_url": "https://cdn.r2c.biz/avatars/tenant-001/engineer.jpg",
    "agent_prompt": "あなたは15年のキャリアを持つ家電エンジニアです。専門知識を持ちながらも分かりやすい言葉で説明し、製品のスペックと生活シーンを結びつけてご案内します。",
    "agent_idle_prompt": "technical expert, confident posture, slight nod",
    "voice_id": "fish-audio-model-id-electronics"
  },
  "fashion": {
    "label": "ファッションコーナー",
    "agent_image_url": "https://cdn.r2c.biz/avatars/tenant-001/stylist.jpg",
    "agent_prompt": "あなたはトレンドに精通したファッションスタイリストです。お客様のライフスタイルに合ったコーディネートを提案し、コーデの楽しさを伝えます。",
    "agent_idle_prompt": "fashionable and elegant, gentle smile",
    "voice_id": "fish-audio-model-id-fashion"
  }
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `label` | string | 任意 | Admin UI 表示用ラベル |
| `agent_image_url` | string \| null | 任意 | カテゴリ用アバター画像 URL（null = 外見変更なし） |
| `agent_prompt` | string | 必須 | カテゴリ用ペルソナプロンプト |
| `agent_idle_prompt` | string | 任意 | カテゴリ用アイドルプロンプト（省略時は変更なし） |
| `voice_id` | string \| null | 任意 | Fish Audio reference_id（null = 声変更なし） |

---

## LemonSlice Control API 呼び出し設計

### 既存 `control_lemonslice` ヘルパー（agent.py:78）

```python
# 既存（変更不要）
async def control_lemonslice(event: str, **kwargs) -> bool:
    ...
    await httpx.AsyncClient().post(
        f"https://lemonslice.com/api/liveai/sessions/{_lemonslice_session_id}/control",
        json={"event": event, **kwargs},
    )
```

### カテゴリ変化時のコントロールシーケンス

```python
async def handle_category_change(category: str, persona: dict) -> None:
    tasks = []

    # 1. 人格プロンプト差し替え（必須）
    tasks.append(control_lemonslice("update_agent_prompt", agent_prompt=persona["agent_prompt"]))

    # 2. アイドルプロンプト差し替え（任意）
    if persona.get("agent_idle_prompt"):
        tasks.append(control_lemonslice("update_idle_prompt", agent_idle_prompt=persona["agent_idle_prompt"]))

    # 3. 外見差し替え（任意 — agent_image_url モードのみ有効）
    if persona.get("agent_image_url") and _avatar_mode == "image":
        tasks.append(control_lemonslice("update_image", image_url=persona["agent_image_url"]))

    await asyncio.gather(*tasks, return_exceptions=True)

    # 4. Fish Audio 声質は次回 TTS 合成から自動適用（グローバル更新）
    if persona.get("voice_id"):
        _effective_reference_id = persona["voice_id"]
```

### `on_data_received` への追加ハンドラー

```python
elif msg_type == "category_change":
    category = msg.get("category", "")
    persona = _category_persona_map.get(category)
    if persona and category != _current_category:
        _current_category = category
        logger.info(f"[data_channel] category_change: {category}")
        asyncio.create_task(handle_category_change(category, persona))
    else:
        logger.debug(f"[data_channel] category_change skipped: {category!r}")
```

---

## Widget 側の変更

### `category_change` イベント送信

```js
// widget.js — dialog/turn レスポンス受信後に追加
function maybeSendCategoryChange(newCategory) {
  if (!newCategory || newCategory === _lastSentCategory) return;
  if (!window.__rajiuceRoom?.localParticipant) return;
  _lastSentCategory = newCategory;
  const payload = JSON.stringify({ type: 'category_change', category: newCategory });
  window.__rajiuceRoom.localParticipant.publishData(
    new TextEncoder().encode(payload), { reliable: true }
  );
}
```

`ragCategory` が dialog/turn レスポンスに含まれる場合のみ送信する。

---

## Backend API 変更

### `/dialog/turn` レスポンスへの追加フィールド

```json
{
  "reply": "...",
  "state": "propose",
  "ragCategory": "fashion"
}
```

`ragCategory` は queryPlanner の出力から取得し、`category_persona_map` のキーとして利用可能なものだけ返す（テナントが未設定のカテゴリは null）。

---

## Admin UI 変更

### カテゴリ別ペルソナ設定画面

アバター設定ページ（admin-ui）に新セクションを追加:

```
カテゴリ別ペルソナ設定
┌─────────────────────────────────────────────┐
│ [+ カテゴリを追加]                            │
│                                             │
│ ▼ 家電コーナー (electronics)                 │
│   アバター画像: [アップロード] または [URL入力]  │
│   ペルソナプロンプト: [テキストエリア]            │
│   音声 (Fish Audio): [クローン一覧から選択]      │
│   [削除]                                    │
│                                             │
│ ▼ ファッションコーナー (fashion)               │
│   ...                                       │
└─────────────────────────────────────────────┘
```

API: `PATCH /v1/admin/avatar/configs/:id` の `category_persona_map` フィールドを更新する（既存エンドポイントへの追加）。

---

## 制約と注意事項

### `agent_id` モードでは外見変更不可

LemonSlice のデフォルトアバター 18 体は `agent_id`（`default_01`〜`default_18`）で指定される。
`update_image` は `agent_image_url` モードでのみ有効であり、`agent_id` モードでは外見を変えられない。

→ **ペルソナスワップで外見を変えたい場合はカスタム画像（`agent_image_url`）を使用すること。**

デフォルトアバターを使う場合はプロンプト変更（人格・声）のみ有効。

### 声質変更のタイミング

`_effective_reference_id` を更新しても、現在 TTS 合成中の発話には反映されない。
次の `session.say()` 呼び出し時から新しい声質が適用される（通常は次のユーザー発話に対する返答から）。

### カテゴリ変化の頻度

同一会話内で短時間に多数のカテゴリ変化が発生すると Control API を過剰に呼ぶ可能性がある。
`_current_category` との比較で同一カテゴリへの重複送信を防ぐ（Widget 側・agent 側の両方）。

### agent_id × agent_image_url 排他

現行の avatar_kwargs と同様、カテゴリペルソナの `agent_image_url` はセッション開始時の
モードに依存する（`_avatar_mode` グローバルで管理）。両フィールドを同一ペルソナに設定してもエラーにはしないが、`agent_id` モードのセッションでは `update_image` をスキップする。

---

## 実装ステータス

| コンポーネント | 状態 | 内容 |
|---|---|---|
| **設計完了** | 本ドキュメント | — |
| DB マイグレーション | 未実装 | `avatar_configs.category_persona_map JSONB` 追加 |
| `/dialog/turn` レスポンス拡張 | 未実装 | `ragCategory` フィールド追加 |
| `agent.py` — `on_data_received` 拡張 | 未実装 | `category_change` ハンドラー追加 |
| `agent.py` — `handle_category_change` | 未実装 | Control API × 3 + voice swap |
| `widget.js` — `maybeSendCategoryChange` | 未実装 | DataChannel 送信 |
| Admin UI — カテゴリペルソナ設定画面 | 未実装 | PATCH avatar_configs |

---

## 関連ファイル

| ファイル | 役割 |
|---|---|
| `avatar-agent/agent.py` | 変更対象: `on_data_received` / `handle_category_change` / `_effective_reference_id` |
| `avatar-agent/emotion_tags.py` | 参考: 同様の Fire-and-forget パターン |
| `src/agent/flow/queryPlanner.ts` | `category` 推定（既存） |
| `src/api/dialog/` | `ragCategory` をレスポンスに追加 |
| `src/api/admin/avatar/routes.ts` | `category_persona_map` の GET/PATCH |
| `admin-ui/src/` | カテゴリペルソナ設定 UI |
| `docs/migrations/` | DB マイグレーション SQL |
| `docs/ARCHITECTURE.md` | アバター接続ライフサイクル（`agent_id` vs `agent_image_url` 排他の記述） |
| `docs/AVATAR_SALESFLOW_EMOTION_TAGS.md` | 感情タグ層との関係 |
| `docs/FISH_AUDIO_VOICE_CLONING.md` | `voice_id` / `reference_id` 管理 |
| `docs/proposals/LEMONSLICE_UPGRADE_2026-06.md` | I-4 Dynamic Update 実装詳細 |
| `docs/PIP_AVATAR_PERSISTENCE_DESIGN.md` | LiveKit 接続維持ガード（本機能は PiP 前提） |

---

## 実装 Gate 条件（実装開始前に人間承認が必要なもの）

- [ ] `update_image` が現在の `livekit-agents[lemonslice]==1.5.17` で正式サポートされているか確認（`inspect.signature(control_session)` または LemonSlice API リファレンスで照合）
- [ ] SoShop 参照実装（[lemonsliceai/SoShop](https://github.com/lemonsliceai/SoShop)）の `persona_swap` 呼び出し部分を読んで、本設計と齟齬がないか確認
- [ ] `agent_id` モードのテナントに対して `update_image` をスキップする仕様で合意
- [ ] カテゴリ名の正規化ルール（小文字英数字・アンダースコアのみ等）を管理者ドキュメントに記載

## 実装 Gate 条件（コード完成後）

- `pnpm verify`（typecheck / lint / test）全通過
- Playwright: カテゴリ変化 → agent_prompt が変わることを DataChannel ログで確認
- Playwright: カテゴリ変化 → LiveKit Room が切断・再接続されないことを確認
- staging 環境でカテゴリ切替時のアバター外見変化を目視確認（`agent_image_url` モード）
