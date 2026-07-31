# 管理API（agent / chat-history）

## スコープ
- `agent/` — 管理AIエージェント。ツールは45本（2026-07-31時点、`toolDefinitions.ts`）。`POST /v1/admin/agent/chat` が唯一の入口。
- `chat-history/` — 会話ログの一覧・本文・削除・成果記録・エスカレーション。
- 決定の履歴: `docs/CHAT_SURFACE_DECISION.md` / `docs/LEGACY_UI_SUNSET.md` / `docs/AGENT_METRICS.md` / `docs/CHAT_HISTORY_CATEGORY_REQUIREMENTS.md`

## 認可（最優先）
- `tenantId` は **JWT の `app_metadata` のみ**を信頼する。`user_metadata` とトップレベル claim は特権判定に使わない（クライアント編集可能）。
- `targetTenantId` は `isSuperAdmin` のときだけ効く。client_admin が送っても無視される（サーバが主役）。
- **previewMode 中の super_admin に `{kind:"global"}` スコープを使わない。** ロールは super_admin のままなので、そのまま流用すると所有権チェックが外れる。チャット経路は常に実効テナントスコープ。
- テナント越境は **権限エラーではなく「不存在」** として返す（存在の推測を許さない）。

## SQL の扱い（実害のある落とし穴）
- **`chatHistoryRepository.getSessions()` は引数を一切検証していない。** `period` と `sort_order` は SQL に**文字列補間**される。検証は呼び出し側（`chat-history/routes.ts` の allowlist）が全て担っている。
  → **新しい呼び出し元（特に LLM 由来の引数）は必ず同じ allowlist で再検証する。** 不正値はエラーにせず `undefined` にフォールバック。
- `search` はパラメータ化されているが `%` `_` が**エスケープされていない**。LLM 経由で渡すならエスケープする（規約は `resolveSessionByShortId` の実装が正）。
- **セッション特定は必ず `resolveSessionByShortId()` 経由。** 生SQLの `session_id LIKE` を書かない（tenant_id条件・ワイルドカードエスケープ・衝突時の候補提示を内包）。
- **セッション削除は必ず `deleteSessionRepository.deleteSession()` 経由。** `reason` 5–500文字必須 / `audit_logs` 同一TX / `FOR UPDATE` / `lock_timeout 3s` を内包する。削除SQLを新規に書かない。`reason` をモデルに生成させない（監査証跡が無価値になる）。

## ツールを追加・変更するときの必須手順
1. `toolDefinitions.ts` に定義（**同じ関心事で別名ツールを増やさない**。既存ツールの `parameters` 拡張を第一候補にする）
2. `actionExecutor.ts` に `case` を追加
3. **`confirmPolicy.ts` に登録**（`WRITE_TOOL_RISK_TIERS` の low/medium/high、または `NON_WRITE_TOOLS`）。漏らすと `confirmPolicy.test.ts` の網羅性テストが落ちる（意図的な設計）
4. フロントの日本語ラベル（`admin-ui/.../copilot-preview/index.tsx` の `REAL_TOOL_LABEL`）を追加

## 壊してはいけない契約
- **ブロック判定文字列**: `確認が必要です` / `確認をスキップできません`。フロントは `確認が必要`、計測は `確認が必要です` で**判定が非対称**なので、文言を変えると UI のチップ出し分けと計測が同時に壊れる。
- **`card` は `text` の置き換えではなく追加。** card 非対応クライアント（パネル）でも自然文だけで意味が通ること。
- **ツール結果は `truncate`（500字）で一律に切られる。** 閲覧系で緩める場合も**書き込み系の結果長を変えない**。打ち切るなら「全N件中M件」を必ず残し、黙って切らない。
- **計測は `agentRoutes.ts` にのみ書く**（45個の case に散らさない）。**fire-and-forget** で、計測の失敗が応答のステータス・本文を変えてはならない。
- **`LEGACY_UI_FEATURES` の値を安易に増減しない。** 削ると `agent_legacy_handoff` が黙って `unknown` に丸まり、旧UIクローズ判定の分子が壊れる。
- `MAX_TOOL_HOPS = 4`。1ターンで「一覧→絞り込み→本文→要約」を全部やらせる設計にしない。

## テストで最低限
- **allowlist 回帰** — allowlist 外の `period` / `sort_order` が SQL の文字列補間に到達しないことを固定する。
- **`confirmPolicy.test.ts` の網羅性** — 全ツールがどちらかの表に属すること。
- **プロンプト注入** — 顧客が書いた文字列（`get_chat_session_messages` の結果）に指示文が混ざっていても、**ユーザーの明示同意なしに書き込み・削除が実行されない**こと。削除ツールがある以上これは必須。
- **確認ゲート** — `confirmed` なしの書き込みはブロックされ **DBが無変更**。同一ターンの `suggest_* → save_*` 連鎖もブロック。
- **境界値** — `limit`/`offset` の 0・上限・負値・NaN。`getSessions` の `limit` には下限クランプが無い。
- テストは既存の `*.test.ts` に追記する。

## 命名・エラーハンドリング
- ツール名は snake_case。`get_*`(読み取り) / `suggest_*`(下書き・非永続) / `save_*`・`add_*`・`update_*`・`delete_*`(書き込み)。
- card の `kind` は snake_case（`legacy_link`）。**UI側は camelCase** で非対称だが、統一のために両側を触らない。
- ツールの結果文字列は**そのままユーザーに見える**前提で書く。スタック・SQL・内部IDを含めない。失敗時も「次に何をすればよいか」を含める。
- 例外は握って文字列で返すのが既存規約（`logger.warn` + ユーザー向け文言）。ただし**失敗を黙って成功にしない**（削除の lock_timeout 超過、出力の打ち切り）。
- PII（顧客名・電話番号・会話本文・検索語）をメトリクスラベルやログに入れない。
