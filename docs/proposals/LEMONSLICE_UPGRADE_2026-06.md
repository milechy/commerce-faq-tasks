# LemonSlice 全機能実装提案書
**作成日**: 2026-06-10  
**対象ブランチ**: feature/<asana-id>-lemonslice-upgrade  
**承認前確認**: hkobayashi

---

## 実装ステータス（2026-06-15 更新）

| # | 項目 | ステータス | PR | 備考 |
|---|------|----------|-----|------|
| I-1 | パッケージ 1.5.5 → 1.5.12 | ✅ MERGED | #342 | 1.5.17 まで更新済み |
| I-2 | LemonSlice 2.1 Flash + `response_done_timeout` 調整 | ⏳ PENDING | — | staging 計測待ち（response_done_timeout=4.0 維持中） |
| I-3 | WebRTC Simulcast 有効化 | ✅ MERGED | #360 | `simulcast: True` 適用済み |
| I-4 | In-Call Dynamic Update（動的プロンプト差し替え） | ✅ MERGED | #364 | SalesFlow 連動実装済み |
| I-5 | Actions (LLM Tool Calls) — Emotion & Gesture Trigger | 🚫 BLOCKED | — | Enterprise 申請待ち（support@lemonslice.com） |
| I-6 | Full-body Avatar — 入力画像サイズ最適化 | ✅ MERGED | #362 | 368×560 リサイズ実装済み |

**残作業**:
- **I-2**: staging で `response_done_timeout` を 4.0 → 3.0 → 2.5 と段階的に計測し、日本語長文応答が途切れない最小値を確定してから PR を作成すること。
- **I-5**: `support@lemonslice.com` に Enterprise 申請後、承認されたら `trigger_avatar_gesture` function_tool を追加する。

---

## 0. エグゼクティブサマリー

R2C は LemonSlice の Self-Managed Pipeline を `livekit-agents[lemonslice]==1.5.5` で利用中。  
LemonSlice 2.1 / 2.1 Flash / 2.5 の一連リリースで以下の新機能が追加されており、  
**6 つの実装項目** でアバター品質・レイテンシ・表現力を大きく引き上げられる。

| # | 項目 | 効果 | 工数目安 | 依存 |
|---|------|------|---------|------|
| I-1 | パッケージ 1.5.5 → 1.5.12 | バグ修正・LemonSlice 2.1 対応基盤 | XS (1h) | なし |
| I-2 | LemonSlice 2.1 Flash + `response_done_timeout` 調整 | 応答遅延 ~2s 短縮 | S (半日) | I-1 |
| I-3 | WebRTC Simulcast 有効化 | モバイル回線の映像品質改善 | XS (1h) | I-1 |
| I-4 | In-Call Dynamic Update（動的プロンプト差し替え） | 会話コンテキスト対応の表情変化 | M (1日) | I-1 |
| I-5 | Actions (LLM Tool Calls) — Emotion & Gesture Trigger | 会話連動ジェスチャー | M (1日) | I-4 ※要Enterprise申請 |
| I-6 | Full-body Avatar — 入力画像サイズ最適化 | 全身アバター品質向上 | S (半日) | I-1 |

> **Enterprise 申請が必要なもの**: I-5 (Actions), Green Screen (別提案)  
> Green Screen は現状 R2C の縦型 widget UI と合わず対象外とした。

---

## 1. 現状把握（実機確認済み）

### 1-1. 利用バージョン
```
# avatar-agent/requirements.txt
livekit-agents[lemonslice,openai]==1.5.5   ← 初期状態
# 2026-06-10 PR #342 で 1.5.17 に更新済み（1.5.12 を超えて最新版を適用）
```

### 1-2. 現在の AvatarSession 呼び出し（agent.py:575-597）
```python
avatar_kwargs = {
    "agent_id": effective_agent_id,         # または agent_image_url（排他）
    "agent_prompt": effective_agent_prompt,
    "idle_timeout": 300,
    "response_done_timeout": 4.0,           # Fish Audio TTS の複数文間ギャップ対応で延長済み
    "agent_idle_prompt": effective_agent_idle_prompt,
    "width": 1080,
    "height": 1920,
    "simulcast": True,                      # I-3: PR #360 で追加済み
}
```

### 1-3. DB スキーマ（avatar_configs テーブル）の関連フィールド
```sql
lemonslice_agent_id  TEXT
image_url            TEXT
agent_prompt         TEXT
agent_idle_prompt    TEXT
avatar_provider      TEXT  -- 現在は全テナント 'lemonslice'
```
`lemonslice_model_version`・`simulcast` などの新フィールドはまだ存在しない。

### 1-4. 影響ファイル全体マップ
```
avatar-agent/
  requirements.txt        ← I-1: バージョン変更（完了）
  agent.py                ← I-1, I-2, I-3, I-4, I-5

src/
  api/admin/avatar/
    routes.ts             ← I-6: 画像リサイズ処理（完了）
  api/internal/
    avatar-config.ts 等   ← I-4: session_id 取得・control API 追加（完了）

docs/migrations/          ← DB マイグレーション（I-4/I-5 で必要な場合）
tests/agent/avatar/       ← 全項目: テスト追加・更新
```

---

## 2. 実装詳細

---

### I-1. パッケージ 1.5.5 → 1.5.12 アップグレード（✅ MERGED PR #342）

#### 変更内容
```diff
# avatar-agent/requirements.txt
-livekit-agents[lemonslice,openai]==1.5.5
+livekit-agents[lemonslice,openai]==1.5.17  # 目標 1.5.12 を超えて最新版を適用
```

#### 実装前確認手順（必須）
| # | 確認事項 | コマンド / 方法 | 期待値 |
|---|---------|--------------|--------|
| 1 | 依存解決テスト | `pip install livekit-agents[lemonslice,openai]==1.5.12 --dry-run` | エラーなし |
| 2 | Breaking change 有無 | [GitHub Releases livekit/agents](https://github.com/livekit/agents/releases) で 1.5.6〜1.5.12 の CHANGELOG 確認 | `AvatarSession` API 変更なし |
| 3 | fish-audio-sdk 互換 | `pip install` 後に `python -c "from livekit.plugins import lemonslice"` | ImportError なし |
| 4 | staging アバター映像確認 | `python agent.py dev` → LiveKit ルームに参加 | 映像・音声が正常に返る |

#### 影響範囲
- `avatar-agent/requirements.txt` の 1 行のみ。
- VPS の `.venv` 再構築が必要（`pip install -r requirements.txt`）。
- **VPS 本番適用は Gate 1〜3 + staging テスト後に限定**（INFRA_AUDIT 準拠）。

#### 注意
`requirements.txt` は `==` ピン留め方針を維持。`>=` に変更しない。

---

### I-2. LemonSlice 2.1 Flash モデル対応 + `response_done_timeout` 再調整（⏳ PENDING）

#### 背景
LemonSlice 2.1 Flash は DiT（Diffusion Transformer）モデルで  
**TTFB 471ms / エンドツーエンド応答 2.04s**（従来比大幅短縮）。  
現在の `response_done_timeout=4.0` は Fish Audio TTS の複数文間ギャップ（~1-2s）対策で設定されたが、  
2.1 Flash のレイテンシ改善に合わせて調整余地がある。

#### 実装前調査（必須）

**Q: プラグイン側でのモデル選択方法は？**  
`livekit-plugins-lemonslice` に `model_version` パラメータが存在するか確認する。

```bash
# 1.5.17 インストール後
python -c "import inspect; from livekit.plugins import lemonslice; print(inspect.signature(lemonslice.AvatarSession.__init__))"
```

- **存在する場合**: `avatar_kwargs` に `model_version="2.1-flash"` を追加
- **存在しない場合**: LemonSlice ダッシュボードの Agent 設定またはアカウント設定でモデルを切り替え  
  （API key に紐付くグローバル設定の可能性が高い）

#### response_done_timeout の調整方針

> ⚠️ `response_done_timeout=4.0` は Fish Audio TTS の複数文間ギャップ（~1-2s）を考慮して  
> 0.5 から延長した値（agent.py コメント参照）。むやみに下げると長文応答で  
> 文の途中にアバターが idle に戻る既知バグが再発する。

段階的に調整し、各ステップで staging 実測する:

```
4.0 → 3.0 → 2.5 → (2.0 は Fish Audio との組み合わせで様子見)
```

**テスト手順（各ステップ）**:
1. FAQの長い回答（3文以上）を 10 回試行
2. 文の途中でアバターが idle に戻らないことを目視確認
3. 応答終了後、設定値 ± 0.3s 以内に idle 状態へ遷移することを確認

#### 変更内容（調査・計測後に決定）
```python
# agent.py の response_done_timeout 2 箇所（agent_image_url / agent_id 両ブランチ）
"response_done_timeout": 2.5,  # 4.0 → X.X (staging 計測値で決定)
```

---

### I-3. WebRTC Simulcast 有効化（✅ MERGED PR #360）

#### 背景
`simulcast: boolean (default: false)` — LemonSlice API 公式パラメータ（LiveKit 専用）。  
複数解像度を同時配信し、クライアント帯域に応じた映像品質を自動選択。  
モバイル回線ユーザーの映像劣化・カクツキを改善する。

#### 変更内容（実装済み）
```diff
# agent.py（agent_id / agent_image_url 両ブランチ両方に追加済み）
 avatar_kwargs = {
     ...
+    "simulcast": True,
 }
```

#### 影響範囲
- `agent.py` の `avatar_kwargs` 2 箇所のみ。
- DB 変更なし（全テナント一律で有効化）。
- LemonSlice 請求への影響: 公式未記載 → **有効化後、最初の請求サイクルで確認**。

---

### I-4. In-Call Dynamic Update（動的プロンプト差し替え）（✅ MERGED PR #364）

#### 背景
LemonSlice 2.1 の目玉機能。アクティブセッション中に REST API で以下を動的変更可能:
- `update_agent_prompt`: 発話中の表情・動作プロンプト
- `update_idle_prompt`: アイドル中の表情・動作プロンプト
- `update_image`: 参照画像の差し替え（場面転換）

```
POST https://lemonslice.com/api/liveai/sessions/{session_id}/control
{ "event": "update_agent_prompt", "agent_prompt": "excited and energetic" }
```

#### R2C での活用シナリオ（実装済み）
| 会話ステート（Phase22/SalesFlow） | 変更する prompt | 内容 |
|----------------------------------|----------------|------|
| `clarify` | agent_prompt | `"attentive and curious, leaning in slightly"` |
| `propose` | agent_prompt | `"enthusiastic and persuasive"` |
| `close` | agent_prompt | `"joyful and celebratory"` |
| `answer` | agent_prompt | `"confident and helpful"` |

#### 実装内容（agent.py に追加済み）

**control_lemonslice ヘルパー**: LemonSlice Control API への fire-and-forget ラッパー。  
**session_id 保持**: `avatar.start()` の戻り値を `_lemonslice_session_id` グローバルに保持。  
**DataChannel リスナー**: `data_received` イベントで SalesFlow ステート変化を受信し、`control_lemonslice` を呼ぶ。

---

### I-5. Actions — Emotion & Gesture Trigger（🚫 BLOCKED — Enterprise 申請待ち）

#### 前提条件
Actions は **Enterprise 専用機能**。各 agent_id に LemonSlice チームがカスタムモーションシーケンスを設定する必要がある。  
→ **実装着手前に `support@lemonslice.com` に申請**。デフォルト 18 アバター（current: default_01〜default_18）全員分の設定が必要。

申請時に伝えるべき情報:
- 対象 agent_id 一覧（`src/api/admin/avatar/routes.ts:21-43` の `lemonslice_agent_id` 全 18 件）
- 必要なアクション名のリスト（下記設計案）

#### R2C 向けアクション設計案
| アクション名 | 動作 | トリガー条件 |
|------------|------|-------------|
| `bow` | お辞儀 | セッション開始・終了の挨拶 |
| `nod_strong` | 大きく頷く | ユーザーの要望確認（clarify） |
| `cheer` | 喜ぶ・祝う | 商談成立（close ステート） |
| `point` | 前方を指差す | 具体的な商品説明（propose） |
| `wave` | 手を振る | 長時間アイドル後の呼びかけ |

#### 実装内容（Enterprise 申請完了後）

```python
# agent.py — function_tool として追加（申請完了後に有効化）
from livekit.agents import function_tool

@function_tool
async def trigger_avatar_gesture(action: str) -> str:
    """
    Trigger a physical avatar gesture for emphasis or emotional expression.
    - Use 'bow' at session start or end greeting.
    - Use 'nod_strong' when acknowledging the user's request.
    - Use 'cheer' when the user confirms a purchase or expresses happiness.
    - Use 'point' when emphasizing a specific product feature.
    - Use 'wave' when reactivating from idle.
    action: one of 'bow', 'nod_strong', 'cheer', 'point', 'wave'
    """
    ok = await control_lemonslice("action", action=action)
    return "gesture triggered" if ok else "gesture unavailable"
```

この `function_tool` を `Agent(instructions=..., tools=[trigger_avatar_gesture])` に渡すと  
Groq LLM が会話コンテキストから自動的に呼び出す。

#### 影響ファイル
- `avatar-agent/agent.py` — function_tool 追加、Agent インスタンス化の変更
- DB: 将来的に `avatar_configs.available_actions TEXT[]` カラム追加で  
  テナント別アクション有効化ができるが、今フェーズは全体一律で OK

---

### I-6. Full-body Avatar — 入力画像サイズ最適化（✅ MERGED PR #362）

#### 背景
LemonSlice API の `agent_image_url` 推奨サイズ: **368 × 560 px（縦型・全身）**。  
`agent_id` を使うデフォルトアバター 18 体は LemonSlice 側で最適化済みのため影響なし。  
カスタム画像アバター（`agent_image_url`）でのみ問題が生じる。

#### 実装内容（実装済み）
```typescript
// src/api/admin/avatar/routes.ts
const LEMONSLICE_IMAGE_WIDTH = 368;
const LEMONSLICE_IMAGE_HEIGHT = 560;
// sharp でリサイズ後に Supabase Storage へアップロード
```

#### 注意事項
- `is_default=true` のアバター画像変更は API で禁止済み（routes.ts:427）。デフォルト 18 体への影響なし。
- 既存の Supabase Storage に保存済みの画像は遡及リサイズしない（別タスク起票）。
- クロップ位置（`position: "top"`）は全身画像の顔が上部という前提。  
  Leonardo.ai の生成プロンプトに「full body, standing」を含むよう admin UI のガイドに追記推奨。

---

## 3. 実装順序と依存グラフ

```
I-6（調査・確認のみ → 他と独立して最小リスク）
  ↓
I-1（パッケージ更新 — 全ての基盤）
  ├── I-3（Simulcast — 1 行追加。I-1 staging テストに同乗可）
  ├── I-2（Flash + timeout — I-1 の staging 計測結果を見てから）
  └── I-4（Dynamic Update — session_id 取得方法確認後に設計）
        └── I-5（Actions — Enterprise 申請完了後）
```

**推奨 PR 分割:**

| PR | 内容 | Gate 2.5 | ステータス |
|---|------|---------|---------|
| PR-A | I-1 + I-3 | スキップ可 | ✅ MERGED（#342 + #360） |
| PR-B | I-2 | スキップ可 | ⏳ PENDING（staging 計測後に作成） |
| PR-C | I-6 | スキップ可 | ✅ MERGED（#362） |
| PR-D | I-4 | **必須** | ✅ MERGED（#364） |
| PR-E | I-5 | **必須** | 🚫 BLOCKED（Enterprise 申請待ち） |

---

## 4. 未解決確認事項（全て実装着手前に解消が必要）

| # | 質問 | 確認方法 | ブロックする項目 | 状態 |
|---|------|---------|--------------|------|
| Q1 | 1.5.6〜1.5.12 に breaking change があるか | [GitHub Releases livekit/agents](https://github.com/livekit/agents/releases) を読む | I-1 | ✅ 解消（PR #342 で 1.5.17 適用済み） |
| Q2 | `AvatarSession` に `simulcast` kwarg があるか | `inspect.signature` で確認 | I-3 | ✅ 解消（extra_payload 経由で渡す方式） |
| Q3 | 2.1 Flash への切り替えはパラメータ指定か、ダッシュボードか | `inspect.signature` + LemonSlice サポートに確認 | I-2 | ⏳ 未解消 |
| Q4 | `AvatarSession` が `session_id` を公開しているか | `dir(avatar)` で確認 | I-4 | ✅ 解消（`avatar.start()` の戻り値） |
| Q5 | Actions 申請の処理期間はどのくらいか | support@lemonslice.com に問い合わせ | I-5 | ⏳ 未申請 |
| Q6 | 現在の `uploadAvatarImage` にリサイズ処理が存在するか | `routes.ts:364` 周辺を読む | I-6 | ✅ 解消（PR #362 で実装済み） |
| Q7 | Simulcast 有効化で LemonSlice の課金は変わるか | 請求ページ確認 or サポートに確認 | I-3 | ⏳ 未確認（次の請求サイクルで確認） |

---

## 5. Gate チェックリスト（各 PR 共通）

```
Gate 1:   pnpm verify (typecheck + lint + test)
Gate 1.5: bash SCRIPTS/dead-code-check.sh
Gate 2:   bash SCRIPTS/security-scan.sh (High/Critical = 0)
Gate 2.5: /codex:review --base main --background  ← PR-D, PR-E は必須
Gate 3:   pnpm build && cd admin-ui && pnpm build
```

**Python コードは Gate 1 の `pnpm verify` 対象外**のため、以下を追加推奨:
```bash
# PR-A 以降、agent.py を変更する PR に追加
cd avatar-agent && pip install ruff mypy && ruff check agent.py && mypy agent.py
```

---

## 6. コスト・リスク評価

| 項目 | コスト影響 | リスク | 軽減策 |
|------|-----------|--------|--------|
| I-1 | なし | pip 依存解決失敗 | dry-run + staging で事前確認（実施済み） |
| I-2 | モデル切り替えで LemonSlice 請求増の可能性 | timeout 短縮で日本語長文が mid-sentence idle | staging 段階的計測（未実施） |
| I-3 | LemonSlice 請求影響不明 | AvatarSession が未対応なら映像落ち | `inspect.signature` で先確認（実施済み） |
| I-4 | LemonSlice API コール増（微小） | session_id 取得失敗 | try-except + graceful fallback（実装済み） |
| I-5 | Enterprise プラン料金発生 | 申請〜設定に時間がかかる | 先行申請（未実施） |
| I-6 | なし | クロップで顔が切れる | `position: "top"` + QA 目視確認（実施済み） |

---

## 7. 参考リンク

- [LemonSlice Self-Managed Capabilities](https://lemonslice.com/docs/self-managed/capabilities)
- [Create Session API](https://lemonslice.com/docs/api-reference/create-self-managed-session)
- [Control Session API](https://lemonslice.com/docs/api-reference/control-self-managed-session)
- [Actions Guide](https://lemonslice.com/docs/guides/actions-guide)
- [LemonSlice 2.1 Capabilities](https://lemonslice.com/docs/overview/capabilities)
- [LemonSlice 2.1 Flash Blog](https://lemonslice.com/blog/lemonslice-flash)
- [livekit-plugins-lemonslice PyPI](https://pypi.org/project/livekit-plugins-lemonslice/)
- [LiveKit × LemonSlice Integration](https://docs.livekit.io/agents/models/avatar/plugins/lemonslice/)
- 実装済み: `avatar-agent/agent.py:61-107` (control_lemonslice, session_id)
- 実装済み: `src/api/admin/avatar/routes.ts` (368×560 リサイズ)
